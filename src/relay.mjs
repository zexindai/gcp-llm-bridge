import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { reasoningObserver } from './reasoning-diagnostics.mjs';
import { relayResponses } from './responses-relay.mjs';
import { json, redact } from './utils.mjs';
import codexModels from '../config/codex/models.json' with { type: 'json' };

const requestHeaders = ['content-type', 'accept', 'content-length', 'content-encoding', 'accept-encoding'];
const responseHeaders = ['content-type', 'content-length', 'content-encoding', 'content-language', 'retry-after', 'cache-control', 'vary'];
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const catalogPath = '/v1/codex/models';
const routes = new Map([['/healthz', 'GET'], ['/v1/models', 'GET'], [catalogPath, 'GET'], ['/v1/chat/completions', 'POST'], ['/v1/responses', 'POST'], ['/v1/alpha/search', 'POST']]);
const digest = value => createHash('sha256').update(value).digest();

function catalogQueryAllowed(url) {
  const params = new URL(url, 'http://bridge.invalid').searchParams;
  const versions = params.getAll('client_version');
  return [...params.keys()].every(name => name === 'client_version')
    && versions.length <= 1
    && versions.every(value => value.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value));
}

function selectHeaders(headers, names) {
  const excluded = new Set([...hopHeaders, ...(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(names.filter(name => headers[name] !== undefined && !excluded.has(name)).map(name => [name, headers[name]]));
}

function error(res, status, code) {
  const messages = {
    invalid_api_key: 'A valid bridge Bearer key is required.',
    not_found: 'Route not found.', method_not_allowed: 'Method not allowed.',
    query_not_allowed: 'Query parameters are not supported.',
    invalid_connection_headers: 'Connection-specific content headers are not supported.',
    upstream_network_error: 'Unable to reach upstream.',
    upstream_timeout: 'Upstream connection or idle timeout.',
    upstream_stream_error: 'Upstream response was interrupted.',
    upstream_protocol_error: 'Unsupported upstream response.',
  };
  json(res, status, { error: { message: messages[code], type: status >= 500 ? 'api_connection_error' : 'invalid_request_error', param: null, code } });
}

// Tests inject only the transport; production configuration always validates the Google URL.
export function createBridgeServer(config, { request = https.request, log = entry => process.stdout.write(`${JSON.stringify(entry)}\n`), reasoningDiagnosticsEnabled = () => false } = {}) {
  const expectedAuth = digest(`Bearer ${config.bridgeApiKey}`);
  const catalog = { models: codexModels.models.filter(model => config.models.includes(model.slug)) };
  const modelsList = Buffer.from(JSON.stringify({ object: 'list', data: config.models.map(id => ({ id, object: 'model', owned_by: id.split('/')[0] })) }));
  const server = http.createServer({ headersTimeout: 30_000, requestTimeout: 300_000 }, (req, res) => {
    const start = performance.now();
    const requestId = randomUUID();
    const path = req.url.split('?')[0];
    const route = routes.has(path) ? path : 'unmatched';
    let fault;
    let faultParam;
    let model;
    let logged = false;
    let diagnosticLog;
    const timings = {};
    const mark = stage => {
      if (timings[stage] !== undefined) return timings[stage];
      const elapsed_ms = Math.round((performance.now() - start) * 1000) / 1000;
      timings[stage] = elapsed_ms;
      diagnosticLog?.('stage_timing', { stage, elapsed_ms });
      return elapsed_ms;
    };
    req.once('end', () => mark('request_body'));
    res.setHeader('x-request-id', requestId);
    const record = () => {
      if (logged) return;
      logged = true;
      log({ request_id: requestId, route, ...(model ? { model } : {}), status: res.headersSent ? res.statusCode : 499,
        duration_ms: Math.round(performance.now() - start),
        timings_ms: { ...timings }, ...(fault ? { fault } : {}), ...(faultParam ? { fault_param: faultParam } : {}),
        ...(!res.writableFinished ? { interrupted: true } : {}) });
    };
    res.once('finish', record);
    res.once('close', () => queueMicrotask(record));
    const reject = (status, code) => { req.resume(); error(res, status, code); };
    if (!routes.has(path)) return reject(404, 'not_found');
    if (req.method !== routes.get(path)) {
      res.setHeader('allow', routes.get(path));
      return reject(405, 'method_not_allowed');
    }
    if (req.url !== path && !(path === catalogPath && catalogQueryAllowed(req.url))) return reject(400, 'query_not_allowed');
    if (path === '/healthz') { req.resume(); return json(res, 200, { status: 'ok' }); }
    if (!timingSafeEqual(expectedAuth, digest(req.headers.authorization ?? ''))) {
      res.setHeader('www-authenticate', 'Bearer realm="gcp-llm-bridge"');
      return reject(401, 'invalid_api_key');
    }
    if (path === '/v1/models') {
      req.resume();
      return json(res, 200, modelsList);
    }
    if (path === catalogPath) {
      req.resume();
      return json(res, 200, catalog);
    }
    const nominated = (req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim());
    if (nominated.some(name => requestHeaders.includes(name))) return reject(400, 'invalid_connection_headers');
    const headers = selectHeaders(req.headers, requestHeaders);
    headers['content-type'] ??= 'application/json';
    headers['x-goog-api-key'] = config.googleApiKey;
    const diagnostic = reasoningDiagnosticsEnabled();
    diagnosticLog = diagnostic ? (event, details) => {
      // Defense in depth for field names/model IDs in diagnostic metadata.
      const serialized = redact(JSON.stringify({ event, request_id: requestId, ...details }), config.bridgeApiKey, config.googleApiKey);
      log(JSON.parse(serialized));
    } : undefined;
    if (diagnostic) diagnosticLog('incoming_request', {
      method: req.method, path: route, header_names: Object.keys(req.headers).slice(0, 64),
      authorization: 'Bearer [redacted]',
    });

    if (path === '/v1/responses' || path === '/v1/alpha/search') {
      void relayResponses(req, res, config, { request, setFault: (code, param) => {
        fault ??= code;
        if (typeof param === 'string' && param.length <= 160 && /^(input|tools|instructions|model|tool_choice|temperature|top_p|top_logprobs|user)(\[\d+\]|\.(content|text|call_id|name|namespace|arguments|input|output|type|role|tools|image_url|detail|encrypted_content))*$/.test(param)) faultParam = param;
      }, diagnosticLog: diagnostic ? diagnosticLog : undefined, mark,
        setModel: name => { model = config.models.includes(name) ? name : undefined; },
        search: path === '/v1/alpha/search' });
      return;
    }

    let upstream;
    let observer;
    let incoming;
    let connectTimer;
    let stopped = false;
    const clearConnectTimer = () => clearTimeout(connectTimer);
    const stop = () => {
      clearConnectTimer();
      req.unpipe(upstream);
      if (observer) { req.unpipe(observer); observer.unpipe(upstream); observer.destroy(); }
      upstream?.destroy();
      incoming?.destroy();
    };
    const fail = (status, code) => {
      if (stopped) return;
      stopped = true;
      fault = code;
      stop();
      req.resume();
      if (res.headersSent) res.destroy();
      else error(res, status, code);
    };
    const cancel = () => {
      if (stopped || res.writableFinished) return;
      stopped = true;
      fault ??= 'client_disconnected';
      stop();
    };
    req.once('aborted', cancel);
    req.once('error', cancel);
    res.once('close', cancel);
    // Backpressure and raw bytes are preserved in both directions; no POST retries.
    try {
      mark('upstream_request');
      upstream = request(config.upstreamUrl, { method: 'POST', headers }, response => {
        incoming = response;
        mark('upstream_headers');
        clearConnectTimer();
        if (stopped) { response.destroy(); return; }
        const status = response.statusCode;
        if (diagnostic) {
          const contentType = response.headers['content-type'] ?? '';
          diagnosticLog('upstream_headers', { status, elapsed_ms: mark('upstream_headers'),
            response_kind: contentType.includes('text/event-stream') ? 'sse' : contentType.includes('application/json') ? 'json' : 'other' });
        }
        response.once('data', () => {
          const elapsed_ms = mark('upstream_first_chunk');
          if (diagnostic) diagnosticLog('upstream_first_chunk', { elapsed_ms });
        });
        const connectionNames = (response.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim());
        if (status < 200 || status > 599 || connectionNames.includes('content-encoding')) {
          response.resume();
          return fail(502, 'upstream_protocol_error');
        }
        res.writeHead(status, selectHeaders(response.headers, responseHeaders));
        res.flushHeaders();
        response.once('aborted', () => fail(502, 'upstream_stream_error'));
        pipeline(response, res, err => {
          if (err) fail(502, 'upstream_stream_error');
        });
      });
      connectTimer = setTimeout(() => fail(504, 'upstream_timeout'), config.connectTimeoutMs);
      connectTimer.unref();
      upstream.once('socket', socket => {
        const connected = () => { clearConnectTimer(); mark('upstream_connected'); };
        if (!socket.connecting) connected();
        else socket.once(socket.encrypted ? 'secureConnect' : 'connect', connected);
      });
      upstream.once('finish', () => mark('upstream_sent'));
      upstream.setTimeout(config.idleTimeoutMs, () => fail(504, 'upstream_timeout'));
      upstream.once('error', () => fail(502, 'upstream_network_error'));
      upstream.once('upgrade', (_response, socket) => { socket.destroy(); fail(502, 'upstream_protocol_error'); });
      if (diagnostic) {
        observer = reasoningObserver(details => diagnosticLog('reasoning_diagnostic', details), req.headers['content-encoding'], { includeRequestShape: true });
        observer.once('error', () => fail(502, 'upstream_network_error'));
        req.pipe(observer).pipe(upstream);
      } else {
        req.pipe(upstream);
      }
    } catch {
      fail(502, 'upstream_network_error');
    }
  });
  // Idle limit, not a total generation deadline. Incoming upload has a separate 5-minute limit.
  server.setTimeout(Math.min(config.idleTimeoutMs + 30_000, 2_147_483_647));
  return server;
}
