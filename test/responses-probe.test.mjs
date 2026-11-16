import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { probeResponses } from '../script/probe-openai-responses.mjs';

const config = loadConfig({ BRIDGE_API_KEY: 'local-bridge-test-1234567890abcdef', GOOGLE_API_KEY: 'current.google.test.key-1234567890', UPSTREAM_URL: 'https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/endpoints/openapi/chat/completions' });

test('Responses probe uses current key once, fixed publisher path, no redirect, and no Bearer by default', async () => {
  let calls = 0;
  const report = await probeResponses(config, { fetchImpl: async (endpoint, options) => {
    calls++;
    assert.equal(endpoint.href, 'https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/publishers/openai/v1/responses');
    assert.equal(options.headers['x-goog-api-key'], config.googleApiKey);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 128);
    return new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: `Rejected ${config.googleApiKey} and ${config.bridgeApiKey}`, details: [{ reason: 'CREDENTIALS_MISSING' }] } }), { status: 401, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(calls, 1);
  assert.equal(report.result, 'rejected');
  assert.ok(!JSON.stringify(report).includes(config.googleApiKey));
  assert.ok(!JSON.stringify(report).includes(config.bridgeApiKey));
  assert.deepEqual(report.error.reasons, ['CREDENTIALS_MISSING']);
});

test('optional Bearer probe is isolated and accepted response is distinguished from incomplete output', async () => {
  const report = await probeResponses(config, { model: 'gpt-6-luna', auth: 'bearer', fetchImpl: async (_endpoint, options) => {
    assert.equal(options.headers.authorization, `Bearer ${config.googleApiKey}`);
    assert.equal(options.headers['x-goog-api-key'], undefined);
    return new Response(JSON.stringify({ object: 'response', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 128, total_tokens: 138 } }), { status: 200 });
  } });
  assert.equal(report.result, 'accepted');
  assert.equal(report.response_status, 'incomplete');
  assert.equal(report.expected_answer, false);
  assert.equal(report.incomplete_reason, 'max_output_tokens');
});

test('probe validates arguments and does not confuse network/parameter failures with authentication failure', async () => {
  await assert.rejects(probeResponses(config, { model: 'invalid' }));
  await assert.rejects(probeResponses(config, { auth: 'invalid' }));
  const network = await probeResponses(config, { fetchImpl: async () => { throw new Error(config.googleApiKey); } });
  assert.equal(network.result, 'network_or_timeout');
  assert.ok(!JSON.stringify(network).includes(config.googleApiKey));
  const invalid = await probeResponses(config, { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 400, message: 'Unsupported max_output_tokens' } }), { status: 400 }) });
  assert.equal(invalid.result, 'rejected');
  assert.match(invalid.explanation, /parameter error/);
  const detail = await probeResponses(config, { fetchImpl: async () => new Response(JSON.stringify({ detail: `Rejected ${config.googleApiKey}` }), { status: 401 }) });
  assert.equal(detail.error.message, 'Rejected [redacted]');
});
