import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { reasoningObserver } from './reasoning-diagnostics.mjs';

const requestHeaders = ['content-type', 'accept', 'content-length', 'content-encoding', 'accept-encoding'];
const responseHeaders = ['content-type', 'content-length', 'content-encoding', 'content-language', 'retry-after', 'cache-control', 'vary'];
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const routes = new Map([['/healthz', 'GET'], ['/v1/models', 'GET'], ['/v1/chat/completions', 'POST']]);
const digest = value => createHash('sha256').update(value).digest();

function selectHeaders(headers, names) {
  const excluded = new Set([...hopHeaders, ...(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(names.filter(name => headers[name] !== undefined && !excluded.has(name)).map(name => [name, headers[name]]));
}

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
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
  const server = http.createServer({ headersTimeout: 30_000, requestTimeout: 300_000 }, (req, res) => {
    const start = performance.now();
    const requestId = randomUUID();
    const path = req.url.split('?')[0];
    const route = routes.has(path) ? path : 'unmatched';
    let fault;
    let logged = false;
    res.setHeader('x-request-id', requestId);
    const record = () => {
      if (logged) return;
      logged = true;
      log({ request_id: requestId, route, status: res.headersSent ? res.statusCode : 499,
        duration_ms: Math.round(performance.now() - start),
        ...(fault ? { fault } : {}), ...(!res.writableFinished ? { interrupted: true } : {}) });
    };
    res.once('finish', record);
    res.once('close', record);
    const reject = (status, code) => { req.resume(); error(res, status, code); };
    if (!routes.has(path)) return reject(404, 'not_found');
    if (req.method !== routes.get(path)) {
      res.setHeader('allow', routes.get(path));
      return reject(405, 'method_not_allowed');
    }
    if (req.url !== path) return reject(400, 'query_not_allowed');
    if (path === '/healthz') { req.resume(); return json(res, 200, { status: 'ok' }); }
    if (!timingSafeEqual(expectedAuth, digest(req.headers.authorization ?? ''))) {
      res.setHeader('www-authenticate', 'Bearer realm="gcp-llm-bridge"');
      return reject(401, 'invalid_api_key');
    }
    if (path === '/v1/models') {
      req.resume();
      return json(res, 200, { object: 'list', data: config.models.map(id => ({ id, object: 'model', owned_by: id.split('/')[0] })) });
    }
    const nominated = (req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim());
    if (nominated.some(name => requestHeaders.includes(name))) return reject(400, 'invalid_connection_headers');
    const headers = selectHeaders(req.headers, requestHeaders);
    headers['content-type'] ??= 'application/json';
    headers['x-goog-api-key'] = config.googleApiKey;
    const diagnostic = reasoningDiagnosticsEnabled();
    const diagnosticLog = (event, details) => {
      // Defense in depth for field names/model IDs in diagnostic metadata.
      const serialized = JSON.stringify({ event, request_id: requestId, ...details })
        .split(config.bridgeApiKey).join('[redacted]').split(config.googleApiKey).join('[redacted]');
      log(JSON.parse(serialized));
    };
    if (diagnostic) diagnosticLog('incoming_request', {
      method: req.method, path: route, header_names: Object.keys(req.headers).slice(0, 64),
      authorization: 'Bearer [redacted]',
    });

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
      upstream = request(config.upstreamUrl, { method: 'POST', headers }, response => {
        incoming = response;
        clearConnectTimer();
        if (stopped) { response.destroy(); return; }
        const status = response.statusCode;
        if (diagnostic) {
          const contentType = response.headers['content-type'] ?? '';
          diagnosticLog('upstream_headers', { status, elapsed_ms: Math.round(performance.now() - start),
            response_kind: contentType.includes('text/event-stream') ? 'sse' : contentType.includes('application/json') ? 'json' : 'other' });
          response.once('data', () => diagnosticLog('upstream_first_chunk', { elapsed_ms: Math.round(performance.now() - start) }));
        }
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
        if (!socket.connecting) clearConnectTimer();
        else socket.once(socket.encrypted ? 'secureConnect' : 'connect', clearConnectTimer);
      });
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
