import { StringDecoder } from 'node:string_decoder';
import { ResponsesError, ResponsesStream, fromChatResponse, toChatRequest } from './responses.mjs';
import { reasoningFields, requestShape } from './reasoning-diagnostics.mjs';
import { toSearchRequest, fromSearchResponse } from './search.mjs';
import { json, redact } from './utils.mjs';

const BODY_LIMIT = 64 * 1024 * 1024;
const EVENT_LIMIT = 8 * 1024 * 1024;

function readBody(source, { upstream = false, onFirstChunk } = {}) {
  const tooLarge = () => new ResponsesError(`${upstream ? 'Upstream' : 'Request'} JSON body exceeds the 64 MiB limit.`, null,
    upstream ? 'upstream_protocol_error' : 'body_too_large', upstream ? 502 : 413);
  if (Number(source.headers?.['content-length']) > BODY_LIMIT) {
    source.resume();
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let firstChunk = true;
    const cleanup = () => {
      source.off('data', data); source.off('end', end); source.off('error', error); source.off('aborted', aborted);
      chunks = [];
    };
    const error = err => { cleanup(); reject(err); };
    const aborted = () => error(new ResponsesError(upstream ? 'Upstream response was interrupted.' : 'The request was interrupted.', null,
      upstream ? 'upstream_stream_error' : 'request_aborted', upstream ? 502 : 400));
    const data = chunk => {
      if (firstChunk) { firstChunk = false; onFirstChunk?.(); }
      size += chunk.length;
      if (size > BODY_LIMIT) {
        error(tooLarge());
        source.resume();
      } else chunks.push(chunk);
    };
    const end = () => { const body = Buffer.concat(chunks); cleanup(); resolve(body); };
    source.on('data', data); source.once('end', end); source.once('error', error); source.once('aborted', aborted);
  });
}

function parseJSON(value, upstream = false) {
  try { return JSON.parse(typeof value === 'string' ? value : value.toString('utf8')); }
  catch { throw new ResponsesError(upstream ? 'Upstream returned invalid JSON.' : 'Request body must be valid JSON.', null,
    upstream ? 'upstream_protocol_error' : 'invalid_json', upstream ? 502 : 400); }
}

// Parse SSE by lines, not TCP chunks: UTF-8, CRLF, comments and multiline data
// may all span arbitrary chunk boundaries. Limits also cover unterminated frames.
export async function* chatEvents(source, onFirstChunk) {
  const decoder = new StringDecoder('utf8');
  let fragments = [];
  let lineBytes = 0;
  let lines = [];
  let eventSize = 0;
  let total = 0;
  let skipLF = false;
  let firstChunk = true;
  const append = value => {
    if (!value) return;
    lineBytes += Buffer.byteLength(value);
    if (lineBytes + eventSize > EVENT_LIMIT) throw new ResponsesError('Upstream SSE event is too large.', null, 'upstream_protocol_error', 502);
    fragments.push(value);
  };
  const line = (value, bytes = 0) => {
    if (!value) {
      const data = lines.length ? lines.join('\n') : undefined;
      lines = []; eventSize = 0;
      return data;
    }
    eventSize += bytes;
    if (eventSize > EVENT_LIMIT) throw new ResponsesError('Upstream SSE event is too large.', null, 'upstream_protocol_error', 502);
    if (value === 'data' || value.startsWith('data:')) lines.push(value === 'data' ? '' : value.slice(5).replace(/^ /, ''));
  };
  const extract = function* (text) {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (skipLF) {
        skipLF = false;
        if (char === '\n') { start = index + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      append(text.slice(start, index));
      const data = line(fragments.join(''), lineBytes);
      fragments = [];
      lineBytes = 0;
      skipLF = char === '\r';
      start = index + 1;
      if (data !== undefined) yield data;
    }
    append(text.slice(start));
  };
  for await (const chunk of source) {
    if (firstChunk) { firstChunk = false; onFirstChunk?.(); }
    total += chunk.length;
    if (total > BODY_LIMIT) throw new ResponsesError('Upstream stream is too large.', null, 'upstream_protocol_error', 502);
    yield* extract(decoder.write(chunk));
  }
  yield* extract(decoder.end());
  // Accept a final frame without a blank line, but never infer successful model completion.
  if (fragments.length) line(fragments.join(''), lineBytes);
  const data = line('');
  if (data !== undefined) yield data;
}

function waitDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error('Client disconnected')); };
    res.once('drain', drain); res.once('close', close);
  });
}

async function writeEvents(res, stream) {
  for (const event of stream.drain()) {
    if (res.destroyed) throw new Error('Client disconnected');
    if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) await waitDrain(res);
  }
}

export async function relayResponses(req, res, config, { request, setFault, diagnosticLog, mark = () => {}, setModel = () => {}, search = false }) {
  let upstream;
  let incoming;
  let connectTimer;
  let stream;
  let stopped = false;
  const stop = () => { clearTimeout(connectTimer); upstream?.destroy(); incoming?.destroy(); };
  const cancel = () => {
    if (stopped || res.writableFinished) return;
    stopped = true;
    setFault('client_disconnected');
    stop();
  };
  req.once('aborted', cancel);
  req.once('error', cancel);
  res.once('close', cancel);
  res.once('error', cancel);
  const fail = async err => {
    if (stopped) return;
    stopped = true;
    const known = err instanceof ResponsesError;
    const status = known ? err.status : 502;
    const code = known ? err.code : stream ? 'upstream_stream_error' : 'upstream_network_error';
    const message = known ? err.message : stream ? 'Upstream response was interrupted.' : 'Unable to reach upstream.';
    setFault(code, known ? err.param : null);
    stop();
    if (res.headersSent) {
      if (stream && !res.destroyed) {
        stream.fail(code, message);
        try { await writeEvents(res, stream); res.end(); } catch { res.destroy(); }
      } else res.destroy();
    } else {
      req.resume();
      json(res, status, { error: { message, type: status >= 500 ? 'api_connection_error' : 'invalid_request_error', param: known ? err.param : null, code } });
    }
  };
  try {
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new ResponsesError('The Responses endpoint requires an uncompressed JSON request.', null, 'unsupported_encoding', 415);
    const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (type && type !== 'application/json') throw new ResponsesError('Content-Type must be application/json.', null, 'unsupported_media_type', 415);
    const originalBody = parseJSON(await readBody(req));
    const body = search ? toSearchRequest(originalBody) : originalBody;
    if (stopped) return;
    setModel(body?.model);
    const { chat, customTools, toolNames } = toChatRequest(body, config.bridgeApiKey);
    if (diagnosticLog) {
      const fields = reasoningFields(chat);
      diagnosticLog('reasoning_diagnostic', { inspection: 'ok', fields, request_shape: requestShape(chat), present: Object.keys(fields).length > 0 });
    }
    const bytes = Buffer.from(JSON.stringify(chat));
    const headers = { 'content-type': 'application/json', 'content-length': bytes.length, 'accept-encoding': 'identity',
      accept: chat.stream ? 'text/event-stream' : 'application/json', 'x-goog-api-key': config.googleApiKey };
    const response = await new Promise((resolve, reject) => {
      mark('upstream_request');
      upstream = request(config.upstreamUrl, { method: 'POST', headers }, value => {
        incoming = value;
        mark('upstream_headers');
        // Teardown can emit an error after a body reader has already rejected.
        value.once('error', () => { void fail(new ResponsesError('Upstream response was interrupted.', null, 'upstream_stream_error', 502)); });
        clearTimeout(connectTimer);
        resolve(value);
      });
      connectTimer = setTimeout(() => {
        reject(new ResponsesError('Upstream connection timed out.', null, 'upstream_timeout', 504));
        stop();
      }, config.connectTimeoutMs);
      connectTimer.unref();
      upstream.once('socket', socket => {
        const connected = () => { clearTimeout(connectTimer); mark('upstream_connected'); };
        if (!socket.connecting) connected();
        else socket.once(socket.encrypted ? 'secureConnect' : 'connect', connected);
      });
      upstream.once('finish', () => mark('upstream_sent'));
      upstream.setTimeout(config.idleTimeoutMs, () => {
        const err = new ResponsesError('Upstream connection or idle timeout.', null, 'upstream_timeout', 504);
        reject(err);
        void fail(err);
      });
      upstream.once('error', reject);
      upstream.once('upgrade', (_response, socket) => {
        socket.destroy();
        reject(new ResponsesError('Unsupported upstream response.', null, 'upstream_protocol_error', 502));
      });
      upstream.end(bytes);
    });
    if (stopped) { response.destroy(); return; }
    const connectionNames = (response.headers.connection ?? '').toLowerCase().split(',').map(name => name.trim());
    if (response.statusCode < 200 || response.statusCode > 599 || (response.statusCode >= 300 && response.statusCode < 400)
      || connectionNames.some(name => ['content-type', 'content-encoding'].includes(name))
      || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      throw new ResponsesError('Unsupported upstream response.', null, 'upstream_protocol_error', 502);
    }
    if (diagnosticLog) diagnosticLog('upstream_headers', { status: response.statusCode, elapsed_ms: mark('upstream_headers'),
      response_kind: response.headers['content-type']?.includes('text/event-stream') ? 'sse' : 'json' });
    if (response.statusCode >= 400) {
      const bytes = await readBody(response, { upstream: true, onFirstChunk: () => mark('upstream_first_chunk') });
      let error;
      try {
        const parsed = JSON.parse(redact(bytes.toString('utf8'), config.bridgeApiKey, config.googleApiKey));
        error = (Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed).error;
      } catch { /* Do not forward HTML or arbitrary upstream bodies. */ }
      if (!error || typeof error.message !== 'string') error = { message: 'Upstream rejected the request.', type: 'api_error', param: null, code: 'upstream_error' };
      if (stopped) return;
      if (response.headers['retry-after'] && !connectionNames.includes('retry-after')) res.setHeader('retry-after', response.headers['retry-after']);
      stopped = true;
      json(res, response.statusCode, { error });
      return;
    }
    if (chat.stream) {
      if (!response.headers['content-type']?.toLowerCase().includes('text/event-stream')) throw new ResponsesError('Expected an upstream SSE response.', null, 'upstream_protocol_error', 502);
      stream = new ResponsesStream(body, customTools, toolNames, config.bridgeApiKey);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      await writeEvents(res, stream);
      let textSeen = false;
      for await (const data of chatEvents(response, () => mark('upstream_first_chunk'))) {
        if (stopped) return;
        if (data === '[DONE]') break;
        if (!data) continue;
        stream.push(parseJSON(data, true));
        if (stream.message && !textSeen) { textSeen = true; mark('first_text'); }
        await writeEvents(res, stream);
      }
      if (stopped) return;
      stream.finish();
      await writeEvents(res, stream);
      res.end();
    } else {
      const result = fromChatResponse(parseJSON(await readBody(response, { upstream: true, onFirstChunk: () => mark('upstream_first_chunk') }), true), body, customTools, toolNames, config.bridgeApiKey);
      if (stopped) return;
      if (result.output.some(item => item.content?.some(part => part.type === 'output_text' && part.text))) mark('first_text');
      json(res, 200, search ? fromSearchResponse(result) : result);
    }
    stopped = true;
    stop();
  } catch (err) {
    await fail(err);
  }
}
