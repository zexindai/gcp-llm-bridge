import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function redact(value, config, limit = 1500) {
  let text = String(value);
  for (const key of [config.googleApiKey, config.bridgeApiKey]) {
    if (key) text = text.split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, limit);
}

export async function probeClaude(config, { model = 'claude-sonnet-5-5', auth = 'api-key', fetchImpl = fetch } = {}) {
  if (!/^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:@\d{8})?$/.test(model)) {
    throw new Error('model must be a Claude Vertex model ID');
  }
  if (!['api-key', 'bearer'].includes(auth)) throw new Error('auth must be api-key or bearer');
  const endpoint = new URL(config.upstreamUrl);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'aiplatform.googleapis.com'
      || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !/^\/v1\/projects\/[a-z0-9][a-z0-9-]*\/locations\/global\/endpoints\/openapi\/chat\/completions$/.test(endpoint.pathname)) {
    throw new Error('Expected the configured global Google Chat Completions endpoint');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/endpoints\/openapi\/chat\/completions$/, `/publishers/anthropic/models/${model}:rawPredict`);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth === 'api-key') headers['x-goog-api-key'] = config.googleApiKey;
  else headers.authorization = `Bearer ${config.googleApiKey}`;
  const report = {
    tested_at_utc: new Date().toISOString(), endpoint: endpoint.href, model,
    credential_source: 'existing GOOGLE_API_KEY in local .env',
    authentication: auth === 'api-key' ? 'x-goog-api-key only' : 'Bearer existing key only; no OAuth token exchange',
    max_tokens: 128, stream: false,
  };
  const start = performance.now();
  let response, data;
  try {
    // One small request, no retries, redirects, OAuth exchange, or Bridge changes.
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16', max_tokens: 128, stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly API_TEST_OK.' }],
      }),
    });
    report.http_status = response.status;
    report.content_type = response.headers.get('content-type');
    const raw = await response.text();
    try { data = JSON.parse(raw); } catch { /* Never print raw HTML or unstructured errors. */ }
  } catch {
    return { ...report, elapsed_ms: Math.round(performance.now() - start), result: 'network_or_timeout', explanation: 'Transport failed; key support and model access remain unknown.' };
  }
  report.elapsed_ms = Math.round(performance.now() - start);
  const envelope = Array.isArray(data) ? data[0] : data;
  if (!response.ok || envelope?.error) {
    const error = envelope?.error ?? envelope;
    report.result = 'rejected';
    report.error = {
      ...(typeof error?.code === 'number' ? { code: error.code } : {}),
      ...(typeof error?.status === 'string' ? { status: redact(error.status, config, 100) } : {}),
      ...(typeof error?.type === 'string' ? { type: redact(error.type, config, 100) } : {}),
      ...(typeof error?.message === 'string' ? { message: redact(error.message, config) } : {}),
      reasons: Array.isArray(error?.details) ? error.details.filter(item => typeof item?.reason === 'string').map(item => redact(item.reason, config, 150)) : [],
    };
    report.explanation = response.status === 401 ? 'This endpoint rejected the supplied credential. Model access has not been established.'
      : response.status === 403 ? 'Access denied. Inspect the error for credential restrictions, IAM or model enablement; 403 alone does not prove API keys are unsupported.'
      : response.status === 404 ? 'Model or route unavailable, or access concealed. Key support cannot be determined from 404 alone.'
      : response.status === 400 ? 'Inspect the error for authentication or parameter problems; 400 alone does not prove API keys are unsupported.'
      : 'Request rejected; inspect the sanitized error. No retry was made.';
  } else if (data?.type === 'message' && data.role === 'assistant' && Array.isArray(data.content)) {
    report.answer = redact(data.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(''), config, 500);
    report.stop_reason = redact(data.stop_reason ?? 'unknown', config, 100);
    report.result = report.answer.trim() ? 'answered' : 'accepted_without_text';
    report.expected_answer = report.answer.trim() === 'API_TEST_OK';
    report.complete = data.stop_reason === 'end_turn';
    if (typeof data.model === 'string') report.returned_model = redact(data.model, config, 100);
    report.usage = Object.fromEntries(['input_tokens', 'output_tokens']
      .filter(key => Number.isSafeInteger(data.usage?.[key])).map(key => [key, data.usage[key]]));
  } else {
    report.result = 'unexpected_response';
    report.explanation = 'Successful HTTP status without a recognizable Claude message; no inference success is claimed.';
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    auth: { type: 'string', default: 'api-key' },
  } });
  const report = await probeClaude(loadConfig(), { model: values.model, auth: values.auth });
  const output = resolve(projectRoot, 'reports', `claude-rawpredict-${values.auth}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report saved: ${output}`);
  if (report.result !== 'answered' || !report.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Claude probe could not start. Check local .env, model/auth arguments and report directory permissions. No secret values were printed.');
    process.exitCode = 2;
  });
}
