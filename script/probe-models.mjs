import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prompt = 'Reply with exactly API_TEST_OK. Do not include explanations.';

function redact(value, config, limit = 2000) {
  let text = String(value);
  for (const secret of [config.bridgeApiKey, config.googleApiKey]) {
    if (secret) text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, limit);
}

async function readJson(response) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error('response_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return undefined; }
}

export async function probeModel(config, model, { endpoint, fetchImpl = fetch, timeoutMs = 180_000 } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw new Error('Invalid model ID');
  const start = performance.now();
  const report = { model, started_at_utc: new Date().toISOString() };
  try {
    // One request per model, no redirects or retries, no tools or extra reasoning parameters.
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${config.bridgeApiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 512 }),
    });
    report.http_status = response.status;
    report.content_type = response.headers.get('content-type');
    const data = await readJson(response);
    const envelope = Array.isArray(data) ? data[0] : data;
    if (!response.ok || envelope?.error) {
      const error = envelope?.error ?? envelope?.detail ?? envelope;
      report.result = 'rejected';
      report.error = {
        ...(typeof error?.code === 'number' ? { code: error.code } : {}),
        ...(typeof error?.status === 'string' ? { status: redact(error.status, config, 150) } : {}),
        ...(typeof error?.message === 'string' ? { message: redact(error.message, config) } : {}),
        ...(typeof error === 'string' ? { message: redact(error, config) } : {}),
        ...(typeof error?.type === 'string' ? { type: redact(error.type, config, 150) } : {}),
        reasons: Array.isArray(error?.details) ? error.details.filter(item => typeof item.reason === 'string').map(item => redact(item.reason, config, 150)) : [],
      };
    } else if (Array.isArray(data?.choices) && data.choices[0]?.message) {
      const choice = data.choices[0];
      const content = choice.message.content;
      const answer = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
      report.result = answer.trim() ? 'answered' : 'accepted_without_text';
      report.answer = redact(answer, config, 1000);
      report.expected_answer = answer.trim() === 'API_TEST_OK';
      report.finish_reason = redact(choice.finish_reason ?? 'unknown', config, 150);
      if (typeof data.model === 'string') report.returned_model = redact(data.model, config, 200);
      report.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
        .filter(key => Number.isSafeInteger(data.usage?.[key])).map(key => [key, data.usage[key]]));
      if (Number.isSafeInteger(data.usage?.completion_tokens_details?.reasoning_tokens)) {
        report.usage.reasoning_tokens = data.usage.completion_tokens_details.reasoning_tokens;
      }
    } else {
      report.result = 'unexpected_response';
    }
  } catch (error) {
    report.result = 'transport_error';
    report.error = { name: redact(error.name, config, 100), ...(error.cause?.code ? { code: redact(error.cause.code, config, 100) } : {}) };
    if (error.message === 'response_too_large') report.error.reason = 'response_too_large';
  }
  report.elapsed_ms = Math.round(performance.now() - start);
  return report;
}

async function main() {
  const config = loadConfig();
  const host = process.env.BIND_IP === '0.0.0.0' ? '127.0.0.1' : (process.env.BIND_IP || '127.0.0.1');
  const baseUrl = `http://${host}:${config.port}`;
  // Stop before generating if the running bridge cannot be reached.
  const health = await fetch(`${baseUrl}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Bridge health check failed');
  const models = [...new Set((await readFile(resolve(root, 'models.txt'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  if (!models.length || models.some(model => !/^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))) throw new Error('Invalid model catalog');
  const report = {
    started_at_utc: new Date().toISOString(), endpoint: `${baseUrl}/v1/chat/completions`,
    upstream: config.upstreamUrl.href, prompt, max_tokens: 512, stream: false,
    concurrency: 3, automatic_retries: 0, models_requested: models.length, results: [],
  };
  const path = resolve(root, 'reports', `chat-models-${report.started_at_utc.replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(path), { recursive: true });
  const results = new Map();
  let next = 0;
  let saving = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify({ ...report, results: models.filter(model => results.has(model)).map(model => results.get(model)) }, null, 2) + '\n';
    // Serialize writes so progress remains readable if the batch is interrupted.
    saving = saving.then(() => writeFile(path, snapshot, { mode: 0o600 }));
    return saving;
  };
  await save();
  console.log(JSON.stringify({ event: 'started', models: models.length, report: path }));
  await Promise.all(Array.from({ length: Math.min(report.concurrency, models.length) }, async () => {
    while (next < models.length) {
      const model = models[next++];
      const result = await probeModel(config, model, { endpoint: report.endpoint });
      results.set(model, result);
      console.log(JSON.stringify({ completed: results.size, of: models.length, ...result }));
      await save();
    }
  }));
  report.finished_at_utc = new Date().toISOString();
  report.summary = Object.fromEntries([...new Set([...results.values()].map(item => item.result))]
    .map(result => [result, [...results.values()].filter(item => item.result === result).length]));
  await save();
  console.log(JSON.stringify({ event: 'finished', ...report.summary, report: path }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Model probe stopped. Check bridge health, local .env, network permissions, and report directory. No secrets were printed.'); process.exitCode = 1; });
}
