import { validateHeaderValue } from 'node:http';

function secret(env, name) {
  const value = env[name]?.trim();
  if (!value || /[<>\s]|change.?me|replace.?me|your[_-]|placeholder/i.test(value)) {
    throw new Error(`${name} must contain a real key, not an example placeholder`);
  }
  try { validateHeaderValue(name, value); }
  catch { throw new Error(`${name} is not a valid HTTP header value`); }
  return value;
}

function integer(env, name, fallback, max = 2_147_483_647) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return Number(raw);
}

export function loadConfig(env = process.env) {
  const bridgeApiKey = secret(env, 'BRIDGE_API_KEY');
  const googleApiKey = secret(env, 'GOOGLE_API_KEY');
  if (bridgeApiKey.length < 24) throw new Error('BRIDGE_API_KEY must be at least 24 characters');
  if (bridgeApiKey === googleApiKey) throw new Error('BRIDGE_API_KEY must differ from GOOGLE_API_KEY');
  if (!env.UPSTREAM_URL?.trim()) {
    throw new Error('UPSTREAM_URL is required; configure the Chat Completions URL for your Google Cloud project');
  }
  let upstreamUrl;
  try { upstreamUrl = new URL(env.UPSTREAM_URL); }
  catch { throw new Error('UPSTREAM_URL must be a valid Google HTTPS URL'); }
  if (upstreamUrl.protocol !== 'https:' || upstreamUrl.hostname !== 'aiplatform.googleapis.com'
      || upstreamUrl.port || upstreamUrl.username || upstreamUrl.password || upstreamUrl.search || upstreamUrl.hash
      || !/^\/v1\/projects\/[a-z0-9][a-z0-9-]*\/locations\/global\/endpoints\/openapi\/chat\/completions$/.test(upstreamUrl.pathname)) {
    throw new Error('UPSTREAM_URL must use the global aiplatform.googleapis.com Chat Completions endpoint without credentials or query parameters');
  }
  const models = [...new Set((env.AVAILABLE_MODELS ?? 'google/gemini-4-argon').split(',').map(s => s.trim()).filter(Boolean))];
  if (!models.length || models.some(model => !/^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))) {
    throw new Error('AVAILABLE_MODELS must contain comma-separated publisher/model IDs');
  }
  return Object.freeze({
    bridgeApiKey, googleApiKey, upstreamUrl, models: Object.freeze(models),
    port: integer(env, 'PORT', 4000, 65535),
    connectTimeoutMs: integer(env, 'CONNECT_TIMEOUT_MS', 10_000),
    idleTimeoutMs: integer(env, 'IDLE_TIMEOUT_MS', 600_000),
  });
}
