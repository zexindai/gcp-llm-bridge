import { loadConfig } from '../src/config.mjs';

// Four small, explicitly invoked billable requests. This script never executes model tools.
const config = loadConfig();
const direct = process.argv.includes('--direct');
const bindIp = process.env.BIND_IP || '127.0.0.1';
const localHost = bindIp === '0.0.0.0' ? '127.0.0.1' : bindIp;
const endpoint = direct ? config.upstreamUrl.href : `http://${localHost}:${config.port}/v1/chat/completions`;
const model = config.models[0];
const auth = direct ? { 'x-goog-api-key': config.googleApiKey } : { authorization: `Bearer ${config.bridgeApiKey}` };
const base = { model, max_tokens: 256, reasoning_effort: 'low' };
const report = value => console.log(JSON.stringify({ target: direct ? 'google-direct' : 'bridge', model, ...value }));

async function send(name, body) {
  const start = performance.now();
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  } catch {
    report({ test: name, result: 'failed', fault: 'network_or_timeout', elapsed_ms: Math.round(performance.now() - start) });
    throw new Error('Network failure or 180-second smoke-test deadline exceeded.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    report({ test: name, status: response.status, result: 'failed', elapsed_ms: Math.round(performance.now() - start) });
    throw new Error('Upstream returned a non-success status. Inspect status and bridge logs locally.');
  }
  return { response, start };
}

async function jsonTest(name, body) {
  const { response, start } = await send(name, body);
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('Missing Chat Completions message.');
  // Only this script's fixed test prompts/responses are reported, never config or headers.
  report({ test: name, status: response.status, elapsed_ms: Math.round(performance.now() - start), answer: message.content, tool_calls: message.tool_calls?.map(call => call.function?.name), usage: data.usage });
  return message;
}

async function main() {
  const question = [{ role: 'user', content: '法国的首都是哪里？请只回答城市名。' }];
  const plain = await jsonTest('text', { ...base, messages: question, stream: false });
  if (!plain.content?.trim()) throw new Error('Empty text answer.');
  if (process.argv.includes('--text-only')) {
    report({ result: 'passed', requests: 1 });
    return;
  }

  const { response, start } = await send('stream', { ...base, messages: question, stream: true });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('Streaming response is not SSE.');
  }
  let pending = '';
  let answer = '';
  let done = false;
  let firstChunkMs;
  let chunks = 0;
  let usage;
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    firstChunkMs ??= Math.round(performance.now() - start);
    chunks++;
    pending += chunk;
    pending = pending.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const event = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { done = true; continue; }
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error('Upstream returned an SSE error.');
      answer += parsed.choices?.[0]?.delta?.content ?? '';
      usage = parsed.usage ?? usage;
    }
  }
  if (!done || !answer.trim()) throw new Error('Incomplete SSE response or empty streaming answer.');
  report({ test: 'stream', status: response.status, first_chunk_ms: firstChunkMs, elapsed_ms: Math.round(performance.now() - start), chunks, answer, usage, done });

  const messages = [{ role: 'user', content: 'Call get_test_value, then tell me its returned value.' }];
  const tools = [{ type: 'function', function: { name: 'get_test_value', description: 'Return the fixed test value 42, with no side effects.', parameters: { type: 'object', properties: {} } } }];
  const toolMessage = await jsonTest('tool-request', { ...base, messages, tools, tool_choice: { type: 'function', function: { name: 'get_test_value' } }, stream: false });
  const calls = toolMessage.tool_calls;
  if (!calls?.length || calls.some(call => !call.id || call.function?.name !== 'get_test_value')) throw new Error('Expected get_test_value tool call was not returned.');
  // Preserve the entire assistant message, including opaque Google signature/extra fields.
  const final = await jsonTest('tool-result', { ...base, messages: [...messages, toolMessage, ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: '42' }))], tools, tool_choice: 'none', stream: false });
  if (!final.content?.includes('42')) throw new Error('Final tool answer did not contain the fixed value.');
  report({ result: 'passed', requests: 4 });
}

try {
  await main();
} catch (err) {
  // Error strings here may originate in parsed data, so redact secrets before printing.
  const message = String(err.message).split(config.googleApiKey).join('[redacted]').split(config.bridgeApiKey).join('[redacted]').slice(0, 300);
  console.error(`Smoke test failed: ${message}`);
  process.exitCode = 1;
}
