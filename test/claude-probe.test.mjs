import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { probeClaude } from '../script/probe-claude.mjs';

const config = loadConfig({
  BRIDGE_API_KEY: 'claude-probe-local-1234567890abcdef', GOOGLE_API_KEY: 'google.test.key-1234567890abcdef',
  UPSTREAM_URL: 'https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/endpoints/openapi/chat/completions',
});

test('Claude probe sends the existing key once to rawPredict in Vertex Messages format', async () => {
  let calls = 0;
  const report = await probeClaude(config, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.href, 'https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/publishers/anthropic/models/claude-sonnet-5-5:rawPredict');
    assert.equal(options.headers['x-goog-api-key'], config.googleApiKey);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      anthropic_version: 'vertex-2023-10-16', max_tokens: 128, stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly API_TEST_OK.' }],
    });
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'API_TEST_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5 } }));
  } });
  assert.equal(calls, 1);
  assert.equal(report.result, 'answered');
  assert.equal(report.complete, true);
  assert.equal(report.expected_answer, true);
});

test('Claude probe preserves authentication error evidence and redacts echoed credentials', async () => {
  const report = await probeClaude(config, { fetchImpl: async () => new Response(JSON.stringify([{ error: {
    code: 401, status: 'UNAUTHENTICATED',
    message: `Rejected ${config.googleApiKey} ${encodeURIComponent(config.bridgeApiKey)} Bearer secret-token`,
    details: [{ reason: 'CREDENTIALS_MISSING' }, null],
  } }]), { status: 401 }) });
  assert.equal(report.result, 'rejected');
  assert.deepEqual(report.error.reasons, ['CREDENTIALS_MISSING']);
  assert.equal(report.error.status, 'UNAUTHENTICATED');
  for (const value of [config.googleApiKey, config.bridgeApiKey, 'secret-token']) assert.ok(!JSON.stringify(report).includes(value));
  assert.match(report.explanation, /Model access has not been established/);
});

test('optional Bearer sends only the same key and empty/truncated replies are not complete answers', async () => {
  const report = await probeClaude(config, { model: 'claude-haiku-4-5@20251001', auth: 'bearer', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${config.googleApiKey}`);
    assert.equal(options.headers['x-goog-api-key'], undefined);
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens' }));
  } });
  assert.equal(report.result, 'accepted_without_text');
  assert.equal(report.complete, false);
  assert.equal(report.expected_answer, false);
});

test('Claude probe rejects unsafe paths before sending and leaves transport/permission errors inconclusive', async () => {
  const neverFetch = async () => { assert.fail('Must not send invalid requests'); };
  await assert.rejects(probeClaude(config, { model: '../other', fetchImpl: neverFetch }));
  await assert.rejects(probeClaude(config, { auth: 'both', fetchImpl: neverFetch }));
  await assert.rejects(probeClaude({ ...config, upstreamUrl: 'https://example.com/' }, { fetchImpl: neverFetch }));
  const network = await probeClaude(config, { fetchImpl: async () => { throw new Error(config.googleApiKey); } });
  assert.equal(network.result, 'network_or_timeout');
  assert.ok(!JSON.stringify(network).includes(config.googleApiKey));
  const denied = await probeClaude(config, { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 403, message: 'Permission denied' } }), { status: 403 }) });
  assert.match(denied.explanation, /403 alone does not prove/);
  const malformed = await probeClaude(config, { fetchImpl: async () => new Response('<html>not JSON</html>') });
  assert.equal(malformed.result, 'unexpected_response');
});
