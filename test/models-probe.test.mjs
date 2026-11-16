import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModel } from '../script/probe-models.mjs';

const config = { bridgeApiKey: 'bridge-test-secret-key-123456', googleApiKey: 'google-test-secret-key-123456' };
const endpoint = 'http://127.0.0.1:4000/v1/chat/completions';

test('model probe makes one bounded bridge request and requires generated text for success', async () => {
  let calls = 0;
  const result = await probeModel(config, 'google/gemini-4-argon', { endpoint, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, endpoint);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { authorization: `Bearer ${config.bridgeApiKey}`, 'content-type': 'application/json', accept: 'application/json' });
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, undefined);
    return Response.json({ model: 'gemini-4-argon', choices: [{ message: { content: 'API_TEST_OK' }, finish_reason: 'stop' }], usage: { total_tokens: 24 } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.result, 'answered');
  assert.equal(result.expected_answer, true);
  assert.deepEqual(result.usage, { total_tokens: 24 });
});

test('model probe preserves Google error details while redacting credentials', async () => {
  let calls = 0;
  const result = await probeModel(config, 'xai/grok-4.7', { endpoint, fetchImpl: async () => {
    calls++;
    return Response.json([{ error: { code: 403, status: 'PERMISSION_DENIED', message: `Denied ${config.googleApiKey} ${config.bridgeApiKey}`, details: [{ reason: 'MODEL_ACCESS_DENIED' }] } }], { status: 403 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.result, 'rejected');
  assert.deepEqual(result.error.reasons, ['MODEL_ACCESS_DENIED']);
  assert.equal(result.error.message, 'Denied [redacted] [redacted]');
});

test('HTTP 200 with exhausted reasoning budget is not reported as an answer', async () => {
  const result = await probeModel(config, 'xai/grok-4.7', { endpoint, fetchImpl: async () => Response.json({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { completion_tokens_details: { reasoning_tokens: 512 } } }) });
  assert.equal(result.result, 'accepted_without_text');
  assert.equal(result.expected_answer, false);
  assert.equal(result.finish_reason, 'length');
  assert.equal(result.usage.reasoning_tokens, 512);
});

test('transport failure remains inconclusive and is not retried', async () => {
  let calls = 0;
  const result = await probeModel(config, 'google/gemini-4-argon', { endpoint, fetchImpl: async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.result, 'transport_error');
  assert.equal(result.error.code, 'ECONNRESET');
});
