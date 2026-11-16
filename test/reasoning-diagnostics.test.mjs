import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { reasoningFields, reasoningObserver, requestShape } from '../src/reasoning-diagnostics.mjs';

test('diagnostic fields are strictly allowlisted and arbitrary strings never leak', () => {
  const body = {
    reasoning_effort: 'HIGH', reasoning: { effort: 'credential-hidden-value', summary: 'private' },
    messages: [{ content: 'private-question' }], tools: [{ secret: 'private-tool' }],
    extra_body: { google: { thinking_config: { thinking_budget: 1024, include_thoughts: false, thinking_level: 'low', secret: 'private-key' } } },
    google: { thinking_config: { thinkingBudget: 'private-key', thinkingLevel: 'private-key' } },
  };
  const fields = reasoningFields(body);
  assert.equal(fields.reasoning_effort, 'high');
  assert.equal(fields['reasoning.effort'], '[invalid]');
  assert.equal(fields['extra_body.google.thinking_config.thinking_budget'], 1024);
  assert.equal(fields['extra_body.google.thinking_config.include_thoughts'], false);
  assert.equal(fields['google.thinking_config.thinkingBudget'], '[invalid]');
  assert.ok(!JSON.stringify(fields).includes('private'));
  assert.ok(!JSON.stringify(fields).includes('credential'));
  assert.deepEqual(reasoningFields(null), {});
});

async function observe(body, encoding) {
  let report;
  const chunks = [];
  const source = Readable.from([body.subarray(0, 17), body.subarray(17)]);
  for await (const chunk of source.pipe(reasoningObserver(value => { report = value; }, encoding))) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  return report;
}

test('diagnostic observer preserves raw Unicode/tools bytes and extracts only effort', async () => {
  const body = Buffer.from('{ "messages":[{"content":"法国 🐈"}],"reasoning_effort":"low", "tools":[{"secret":"private"}]}\n');
  assert.deepEqual(await observe(body), { inspection: 'ok', fields: { reasoning_effort: 'low' }, present: true });
});

test('missing effort is reported distinctly from malformed, oversized, or encoded bodies', async () => {
  assert.deepEqual(await observe(Buffer.from('{}')), { inspection: 'ok', fields: {}, present: false });
  assert.equal((await observe(Buffer.from('{invalid'))).inspection, 'invalid_json');
  assert.equal((await observe(Buffer.alloc(1024 * 1024 + 1, 0x61))).inspection, 'skipped_too_large');
  assert.equal((await observe(Buffer.from('compressed bytes'), 'gzip')).inspection, 'skipped_encoded');
});

test('request shape exposes field structure and counts without conversation or tool values', () => {
  const shape = requestShape({ model: 'google/gemini-4-argon', stream: true, max_tokens: 128,
    messages: [{ role: 'user', content: 'private-question' }, { role: 'tool', content: 'private-result' }],
    tools: [{ function: { name: 'private-function', parameters: { secret: 'private-schema' } } }],
    reasoning: { effort: 'high', summary: 'private-summary' },
    extra_body: { google: { thinking_config: { thinking_budget: 1024 } } },
    other: 'private-value',
  });
  assert.equal(shape.model, 'google/gemini-4-argon');
  assert.equal(shape.stream, true);
  assert.equal(shape.message_count, 2);
  assert.deepEqual(shape.message_roles, { user: 1, tool: 1 });
  assert.equal(shape.tool_count, 1);
  assert.ok(shape.top_level_keys.includes('reasoning'));
  assert.deepEqual(shape.nested_keys.reasoning, ['effort', 'summary']);
  assert.deepEqual(shape.nested_keys['extra_body.google.thinking_config'], ['thinking_budget']);
  assert.ok(!JSON.stringify(shape).includes('private'));
  assert.equal(requestShape({ model: 'secret-key-value' }).model, '[redacted_or_invalid]');
  assert.deepEqual(requestShape({ ['x'.repeat(1000)]: 'secret' }).top_level_keys, ['[nonstandard_field]']);
});
