import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { createBridgeServer } from '../src/relay.mjs';

const TEST_UPSTREAM = 'https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/endpoints/openapi/chat/completions';
const env = { BRIDGE_API_KEY: 'bridge-test-secret-1234567890abcdef', GOOGLE_API_KEY: 'google-test-secret-9876543210abcdef', UPSTREAM_URL: TEST_UPSTREAM };
const auth = { authorization: `Bearer ${env.BRIDGE_API_KEY}` };
const toolBody = Buffer.from(`{ "model":"google/gemini-4-argon", "messages":[{"role":"user","content":"巴黎 🐈"},{"role":"assistant","tool_calls":[{"id":"call-1","type":"function","function":{"name":"get_test_value","arguments":"{}"},"extra_content":{"google":{"thought_signature":"opaque-signature"}}}]},{"role":"tool","tool_call_id":"call-1","content":"42"}], "tools":[{"type":"function","function":{"name":"get_test_value","parameters":{"type":"object","properties":{"nested":{"type":"array","items":{"type":"object","properties":{"x":{"type":"string"}}}}}}}}],"tool_choice":"auto","reasoning_effort":"low","stream":true }\n`);

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

async function fixture(t, handler = (_req, res) => res.end('{}'), overrides = {}, diagnostics = false) {
  const logs = [];
  let count = 0;
  const fake = http.createServer((req, res) => { count++; handler(req, res); });
  const fakePort = await listen(t, fake);
  const targets = [];
  const transport = (url, options, callback) => {
    targets.push(url.href);
    return http.request({ ...options, hostname: '127.0.0.1', port: fakePort, path: '/fixed-upstream', agent: false }, callback);
  };
  const bridge = createBridgeServer({ ...loadConfig(env), ...overrides }, { request: transport, log: e => logs.push(e), reasoningDiagnosticsEnabled: () => diagnostics });
  const port = await listen(t, bridge);
  return { port, logs, targets, count: () => count };
}

function call(port, { path = '/v1/chat/completions', method = 'POST', headers = auth, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function stream(port, headers = auth) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers, agent: false }, resolve);
    req.on('error', reject);
    req.end('{"stream":true}');
  });
}

test('configuration validates keys, numeric settings, models, and fixed Google URL', () => {
  assert.equal(loadConfig(env).upstreamUrl.href, TEST_UPSTREAM);
  for (const value of [undefined, '', '  ']) {
    assert.throws(() => loadConfig({ ...env, UPSTREAM_URL: value }), /UPSTREAM_URL is required/);
  }
  assert.throws(() => loadConfig({ ...env, UPSTREAM_URL: TEST_UPSTREAM.replace('test-project-123', 'YOUR_PROJECT_ID') }), /UPSTREAM_URL/);
  const anotherProject = TEST_UPSTREAM.replace('test-project-123', 'another-project-456');
  assert.equal(loadConfig({ ...env, UPSTREAM_URL: anotherProject }).upstreamUrl.href, anotherProject);
  assert.deepEqual(loadConfig({ ...env, AVAILABLE_MODELS: 'google/gemini-4-argon, google/gemini-4-argon' }).models, ['google/gemini-4-argon']);
  for (const key of ['BRIDGE_API_KEY', 'GOOGLE_API_KEY']) {
    for (const value of ['', '<secret>', 'replace-me', 'bad\r\nheader']) {
      assert.throws(() => loadConfig({ ...env, [key]: value }), { message: new RegExp(key) });
    }
  }
  assert.throws(() => loadConfig({ ...env, BRIDGE_API_KEY: env.GOOGLE_API_KEY }));
  assert.throws(() => loadConfig({ ...env, BRIDGE_API_KEY: 'short' }));
  for (const url of [
    'http://aiplatform.googleapis.com/v1/test', 'https://evil.test/',
    TEST_UPSTREAM + '?key=secret', TEST_UPSTREAM + '#fragment',
    TEST_UPSTREAM.replace('aiplatform.googleapis.com', 'aiplatform.googleapis.com.evil.test'),
    TEST_UPSTREAM.replace('https://', 'https://user:pass@'),
    TEST_UPSTREAM.replace('.com/', '.com:444/'), TEST_UPSTREAM.replace('/global/', '/other/'),
    TEST_UPSTREAM.replace('/chat/completions', '/models'), 'not-a-url',
  ]) assert.throws(() => loadConfig({ ...env, UPSTREAM_URL: url }));
  for (const [name, value] of [['PORT', '0'], ['PORT', '65536'], ['CONNECT_TIMEOUT_MS', '-1'], ['IDLE_TIMEOUT_MS', 'NaN'], ['AVAILABLE_MODELS', ''], ['AVAILABLE_MODELS', 'https://untrusted.test/model'], ['AVAILABLE_MODELS', 'publisher/model/path']]) {
    assert.throws(() => loadConfig({ ...env, [name]: value }));
  }
});

test('model listing accepts publisher namespaces and reports their owners without contacting upstream', { timeout: 5000 }, async t => {
  const ids = ['google/gemini-4-argon', 'xai/grok-4.7', 'deepseek-ai/deepseek-v4.1-flash-maas', 'zai-org/glm-5.2-maas', 'openai/gpt-oss-120b-maas', 'meta/llama-4-scout-17b-16e-instruct-maas'];
  const config = loadConfig({ ...env, AVAILABLE_MODELS: ids.join(',') });
  const f = await fixture(t, undefined, { models: config.models });
  const result = await call(f.port, { method: 'GET', path: '/v1/models', body: '' });
  assert.equal(result.status, 200);
  const models = JSON.parse(result.body).data;
  assert.deepEqual(models.map(model => model.id), ids);
  assert.deepEqual(models.map(model => model.owned_by), ['google', 'xai', 'deepseek-ai', 'zai-org', 'openai', 'meta']);
  assert.equal(f.count(), 0);
});

test('startup fails closed with placeholders without printing secret values', () => {
  const result = spawnSync(process.execPath, ['src/server.mjs'], { env: { ...process.env, ...env, GOOGLE_API_KEY: 'replace-me' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Configuration error: GOOGLE_API_KEY/);
  assert.ok(!result.stderr.includes(env.BRIDGE_API_KEY));
});

test('health is local; model listing requires auth; invalid keys never reach upstream', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${env.BRIDGE_API_KEY}` }, { 'x-goog-api-key': env.GOOGLE_API_KEY }]) {
    assert.equal((await call(f.port, { headers })).status, 401);
  }
  assert.equal((await call(f.port, { method: 'GET', path: '/v1/models', headers: {} })).status, 401);
  const models = await call(f.port, { method: 'GET', path: '/v1/models', body: '' });
  assert.equal(models.status, 200);
  assert.equal(JSON.parse(models.body).data[0].id, 'google/gemini-4-argon');
  const health = await call(f.port, { method: 'GET', path: '/healthz', headers: {}, body: '' });
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal(f.count(), 0);
});

test('raw tools and Unicode body passes unchanged with only server-owned Google authentication', { timeout: 5000 }, async t => {
  let seen;
  const f = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = { headers: req.headers, body: Buffer.concat(chunks), path: req.url };
    res.setHeader('content-type', 'application/json');
    res.end(toolBody);
  });
  const result = await call(f.port, { headers: {
    ...auth, 'x-goog-api-key': 'client-key-never-forward', 'x-api-key': 'client-other-key',
    'proxy-authorization': 'sensitive', cookie: 'secret-cookie', host: 'attacker.invalid',
    'x-upstream-url': 'http://attacker.invalid', 'x-request-id': 'spoofed',
    'content-type': 'application/json', accept: 'text/event-stream', 'content-length': toolBody.length,
  }, body: toolBody });
  assert.equal(result.status, 200);
  assert.deepEqual(seen.body, toolBody);
  assert.deepEqual(result.body, toolBody);
  assert.equal(seen.headers['x-goog-api-key'], env.GOOGLE_API_KEY);
  for (const name of ['authorization', 'x-api-key', 'proxy-authorization', 'cookie', 'x-upstream-url', 'x-request-id']) assert.equal(seen.headers[name], undefined);
  assert.notEqual(seen.headers.host, 'attacker.invalid');
  assert.equal(seen.headers.accept, 'text/event-stream');
  assert.notEqual(result.headers['x-request-id'], 'spoofed');
  assert.deepEqual(f.targets, [TEST_UPSTREAM]);
});

test('binary gzip request and gzip response retain byte content and encoding', { timeout: 5000 }, async t => {
  const compressed = gzipSync(toolBody);
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.headers['content-encoding'], 'gzip');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), compressed);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length });
    res.end(compressed);
  });
  const r = await call(f.port, { body: compressed, headers: { ...auth, 'content-encoding': 'gzip', 'content-length': compressed.length } });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(Number(r.headers['content-length']), compressed.length);
  assert.deepEqual(r.body, compressed);
  assert.deepEqual(gunzipSync(r.body), toolBody);
});

test('SSE first chunk arrives before upstream is allowed to finish, preserving exact events', { timeout: 5000 }, async t => {
  let finish;
  const first = 'data: {"delta":"巴"}\n\n';
  const last = 'data: {"delta":"黎"}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(first);
    finish = () => res.end(last);
  });
  const res = await stream(f.port);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const chunks = [];
  res.on('data', c => chunks.push(c));
  await once(res, 'data');
  assert.equal(Buffer.concat(chunks).toString(), first);
  const ended = once(res, 'end');
  finish();
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), first + last);
});

test('slow client receives a multi-megabyte response through backpressure without corruption', { timeout: 5000 }, async t => {
  const body = Buffer.alloc(2 * 1024 * 1024, 0xab);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  });
  const res = await stream(f.port);
  res.pause();
  await new Promise(resolve => setTimeout(resolve, 30));
  const chunks = [];
  for await (const c of res) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), body);
});

test('Google error status, raw JSON, and retry-after pass through without retries', { timeout: 5000 }, async t => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    await t.test(`status ${status}`, async t => {
      const body = Buffer.from(`{ "error": {"message":"上游错误 ${status}"} }`);
      const f = await fixture(t, (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '17' });
        res.end(body);
      });
      const r = await call(f.port);
      assert.equal(r.status, status);
      assert.equal(r.headers['retry-after'], '17');
      assert.deepEqual(r.body, body);
      assert.equal(f.count(), 1);
    });
  }
});

test('hop-by-hop and connection-nominated response headers are stripped', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { connection: 'close, retry-after', 'retry-after': '999', 'keep-alive': 'timeout=999', 'content-type': 'application/json' });
    res.end('{}');
  });
  const r = await call(f.port);
  assert.equal(r.headers['retry-after'], undefined);
  assert.equal(r.headers['keep-alive'], undefined);
  assert.notEqual(r.headers.connection, 'close, retry-after');
});

test('paths, methods, query overrides, and connection-nominated request content headers are rejected', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const path of ['/v1/responses', '/healthz/other', 'http://attacker.invalid/v1/chat/completions']) {
    assert.equal((await call(f.port, { path })).status, 404);
  }
  assert.equal((await call(f.port, { method: 'GET' })).status, 405);
  assert.equal((await call(f.port, { path: '/v1/chat/completions?url=http://attacker.invalid&key=private' })).status, 400);
  assert.equal((await call(f.port, { headers: { ...auth, connection: 'content-encoding' } })).status, 400);
  assert.equal(f.count(), 0);
});

test('network failure before headers returns sanitized OpenAI JSON and never retries', { timeout: 5000 }, async t => {
  const f = await fixture(t, req => req.socket.destroy());
  const r = await call(f.port);
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body).error.code, 'upstream_network_error');
  assert.equal(f.count(), 1);
});

test('socket idle timeout before headers returns 504 and cancels upstream', { timeout: 5000 }, async t => {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const f = await fixture(t, (req, res) => { req.resume(); res.on('close', close); }, { idleTimeoutMs: 70 });
  const r = await call(f.port);
  assert.equal(r.status, 504);
  assert.equal(JSON.parse(r.body).error.code, 'upstream_timeout');
  await closed;
});

test('connection deadline includes DNS and cancels a transport that never connects', { timeout: 5000 }, async t => {
  const pending = new PassThrough();
  pending.setTimeout = () => pending;
  const bridge = createBridgeServer({ ...loadConfig(env), connectTimeoutMs: 50 }, { request: () => pending, log: () => {} });
  const port = await listen(t, bridge);
  const r = await call(port);
  assert.equal(r.status, 504);
  assert.equal(pending.destroyed, true);
});

test('client cancellation tears down the upstream stream', { timeout: 5000 }, async t => {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.on('close', close);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: hello\n\n');
  });
  const res = await stream(f.port);
  await once(res, 'data');
  res.destroy();
  await closed;
});

test('upstream mid-stream disconnect aborts downstream without inventing a DONE event', { timeout: 5000 }, async t => {
  let cut;
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    cut = () => res.destroy();
  });
  const res = await stream(f.port);
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('error', () => {});
  await once(res, 'data');
  const aborted = new Promise(resolve => res.once('aborted', resolve));
  cut();
  await aborted;
  assert.equal(res.complete, false);
  assert.equal(Buffer.concat(chunks).toString(), 'data: partial\n\n');
});

test('SSE idle timeout after headers interrupts rather than appending JSON or success', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: waiting\n\n');
  }, { idleTimeoutMs: 70 });
  const res = await stream(f.port);
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('error', () => {});
  await new Promise(resolve => res.once('aborted', resolve));
  assert.equal(res.complete, false);
  assert.equal(Buffer.concat(chunks).toString(), 'data: waiting\n\n');
});

test('logs contain safe route/status/timing only, never keys, query, bodies, or raw errors', { timeout: 5000 }, async t => {
  const f = await fixture(t, req => req.socket.destroy());
  await call(f.port, { path: '/private-query?key=private-query-secret', body: 'private-body-secret' });
  await call(f.port, { headers: { authorization: 'Bearer private-auth-secret' } });
  await call(f.port);
  const logs = JSON.stringify(f.logs);
  for (const secret of [...Object.values(env), 'private-query', 'private-body-secret', 'private-auth-secret', 'http://', 'socket hang up']) assert.ok(!logs.includes(secret));
  assert.equal(f.logs.length, 3);
  assert.equal(f.logs[0].route, 'unmatched');
  assert.equal(f.logs[2].fault, 'upstream_network_error');
  assert.equal(f.logs[2].status, 502);
});

test('active SSE can run longer than the connect/idle limits without a total deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: start\n\n');
    let count = 0;
    const timer = setInterval(() => {
      res.write('data: heartbeat\n\n');
      if (++count === 8) { clearInterval(timer); res.end('data: [DONE]\n\n'); }
    }, 30);
    res.once('close', () => clearInterval(timer));
  }, { connectTimeoutMs: 100, idleTimeoutMs: 150 });
  const r = await call(f.port);
  assert.equal(r.status, 200);
  assert.ok(r.body.toString().endsWith('data: [DONE]\n\n'));
  assert.equal(r.body.toString().match(/heartbeat/g).length, 8);
});

test('client cancellation before upstream headers also tears down upstream', { timeout: 5000 }, async t => {
  let received;
  let closed;
  const accepted = new Promise(resolve => { received = resolve; });
  const cancelled = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.once('close', closed);
    received();
  });
  const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST', headers: auth, agent: false });
  req.on('error', () => {});
  req.end('{}');
  await accepted;
  req.destroy();
  await cancelled;
});

test('upstream redirect is never followed to an arbitrary second host', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(307, { location: 'http://attacker.invalid/steal', 'content-type': 'application/json' });
    res.end('{"redirect":true}');
  });
  const r = await call(f.port);
  assert.equal(r.status, 307);
  assert.equal(r.headers.location, undefined);
  assert.equal(f.count(), 1);
});

test('enabled reasoning diagnostics preserve actual upstream bytes and correlate safe metadata with status', { timeout: 5000 }, async t => {
  let received;
  const f = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    res.end('{}');
  }, {}, true);
  const response = await call(f.port, { body: toolBody });
  assert.equal(response.status, 200);
  assert.deepEqual(received, toolBody);
  const diagnostic = f.logs.find(entry => entry.event === 'reasoning_diagnostic');
  assert.deepEqual(diagnostic.fields, { reasoning_effort: 'low' });
  assert.equal(diagnostic.present, true);
  assert.equal(diagnostic.request_shape.model, 'google/gemini-4-argon');
  assert.equal(diagnostic.request_shape.stream, true);
  const arrival = f.logs.find(entry => entry.event === 'incoming_request');
  assert.equal(arrival.method, 'POST');
  assert.equal(arrival.path, '/v1/chat/completions');
  assert.equal(arrival.authorization, 'Bearer [redacted]');
  assert.equal(f.logs.find(entry => entry.event === 'upstream_headers').status, 200);
  assert.ok(f.logs.some(entry => entry.event === 'upstream_first_chunk'));
  const completed = f.logs.find(entry => entry.route === '/v1/chat/completions' && entry.status === 200);
  assert.equal(diagnostic.request_id, completed.request_id);
  const logs = JSON.stringify(f.logs);
  for (const value of [...Object.values(env), '巴黎', 'opaque-signature', 'get_test_value']) assert.ok(!logs.includes(value));
});
