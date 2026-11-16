import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';

const supportedModels = new Set(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-terra']);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function redact(value, config, limit = 1500) {
  let result = String(value);
  for (const key of [config.googleApiKey, config.bridgeApiKey]) {
    if (key) result = result.split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]');
  }
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, limit);
}

export async function probeResponses(config, { model = 'gpt-6.1-sol', auth = 'api-key', fetchImpl = fetch } = {}) {
  if (!supportedModels.has(model)) throw new Error('Choose gpt-6.1-sol, gpt-6-luna, gpt-6-astra, or gpt-6.1-terra');
  if (!['api-key', 'bearer'].includes(auth)) throw new Error('auth must be api-key or bearer');
  const endpoint = new URL(config.upstreamUrl);
  endpoint.pathname = endpoint.pathname.replace(/\/endpoints\/openapi\/chat\/completions$/, '/publishers/openai/v1/responses');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth === 'api-key') headers['x-goog-api-key'] = config.googleApiKey;
  else headers.authorization = `Bearer ${config.googleApiKey}`;
  const report = {
    tested_at_utc: new Date().toISOString(), endpoint: endpoint.href, model,
    credential_source: 'existing GOOGLE_API_KEY in local .env',
    authentication: auth === 'api-key' ? 'x-goog-api-key only' : 'Bearer existing static key only',
    max_output_tokens: 128,
  };
  const start = performance.now();
  let response;
  let data;
  try {
    // Exactly one request per invocation; never follow redirects or retry generation.
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model, input: 'Reply with exactly API_TEST_OK.', max_output_tokens: 128, stream: false, store: false }),
    });
    report.http_status = response.status;
    report.content_type = response.headers.get('content-type');
    const raw = await response.text();
    try { data = JSON.parse(raw); } catch { /* Never print unstructured HTML or other raw responses. */ }
  } catch {
    return { ...report, elapsed_ms: Math.round(performance.now() - start), result: 'network_or_timeout', explanation: 'No authentication conclusion can be drawn from this transport failure.' };
  }
  report.elapsed_ms = Math.round(performance.now() - start);
  if (!response.ok || data?.error) {
    const envelope = Array.isArray(data) ? data[0] : data;
    const error = envelope?.error ?? envelope?.detail ?? envelope;
    report.result = 'rejected';
    report.error = {
      ...(typeof error?.code === 'number' ? { code: error.code } : {}),
      ...(typeof error?.status === 'string' ? { status: redact(error.status, config, 100) } : {}),
      ...(typeof error?.message === 'string' ? { message: redact(error.message, config) } : {}),
      ...(typeof error === 'string' ? { message: redact(error, config) } : {}),
      ...(typeof error?.type === 'string' ? { type: redact(error.type, config, 100) } : {}),
      reasons: Array.isArray(error?.details) ? error.details.filter(item => typeof item.reason === 'string').map(item => redact(item.reason, config, 150)) : [],
    };
    report.explanation = response.status === 401 ? 'Authentication was rejected. This does not establish whether the project has model access.'
      : response.status === 403 ? 'Access denied; check the error for IAM, model enablement, or preview-access requirements.'
      : response.status === 400 ? 'Request was rejected; a parameter error alone does not prove the key is unsupported.'
      : 'Inspect the recorded status and sanitized error; no automatic retry was made.';
  } else if (data?.object === 'response') {
    report.result = 'accepted';
    report.response_status = redact(data.status ?? 'unknown', config, 100);
    const text = (data.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text')
      .map(part => part.text ?? '').join('');
    report.answer = redact(text, config, 500);
    report.expected_answer = report.answer.trim() === 'API_TEST_OK';
    if (data.incomplete_details?.reason) report.incomplete_reason = redact(data.incomplete_details.reason, config, 100);
    report.usage = Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens']
      .filter(key => Number.isSafeInteger(data.usage?.[key])).map(key => [key, data.usage[key]]));
  } else {
    report.result = 'unexpected_response';
    report.explanation = 'The HTTP response was successful but was not a recognizable Responses object.';
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: { model: { type: 'string', default: 'gpt-6.1-sol' }, auth: { type: 'string', default: 'api-key' } } });
  const config = loadConfig();
  const report = await probeResponses(config, { model: values.model, auth: values.auth });
  const output = resolve(projectRoot, 'reports', `openai-responses-${values.auth}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report saved: ${output}`);
  if (report.result !== 'accepted') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Probe could not start. Check local .env, model/auth arguments, and report directory permissions. No secret values were printed.'); process.exitCode = 2; });
}
