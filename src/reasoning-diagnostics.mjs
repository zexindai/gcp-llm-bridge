import { Transform } from 'node:stream';

const LIMIT = 1024 * 1024;
const levels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'default']);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const level = value => typeof value === 'string' && levels.has(value.toLowerCase()) ? value.toLowerCase() : '[invalid]';
const keys = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).slice(0, 64).map(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key) ? key : '[nonstandard_field]') : [];

export function requestShape(body) {
  const shape = { top_level_keys: keys(body) };
  if (own(body, 'model')) shape.model = typeof body.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(body.model) ? body.model : '[redacted_or_invalid]';
  if (own(body, 'stream')) shape.stream = typeof body.stream === 'boolean' ? body.stream : '[invalid]';
  for (const name of ['max_tokens', 'max_completion_tokens']) {
    if (own(body, name)) shape[name] = Number.isSafeInteger(body[name]) ? body[name] : '[invalid]';
  }
  if (Array.isArray(body?.messages)) {
    shape.message_count = body.messages.length;
    shape.message_roles = {};
    for (const message of body.messages) {
      const role = ['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message?.role) ? message.role : 'other';
      shape.message_roles[role] = (shape.message_roles[role] ?? 0) + 1;
    }
  }
  if (Array.isArray(body?.tools)) shape.tool_count = body.tools.length;
  shape.nested_keys = {};
  for (const path of ['reasoning', 'thinking', 'extra_body', 'google', 'extra_body.google', 'extra_body.google.thinking_config', 'google.thinking_config', 'thinking_config', 'thinkingConfig', 'generationConfig', 'generationConfig.thinkingConfig']) {
    const value = path.split('.').reduce((object, key) => object?.[key], body);
    if (value !== undefined) shape.nested_keys[path] = keys(value);
  }
  return shape;
}

// Never return arbitrary strings, prompt content, tools, signatures, or credentials.
export function reasoningFields(body) {
  const result = {};
  if (own(body, 'reasoning_effort')) result.reasoning_effort = level(body.reasoning_effort);
  if (own(body?.reasoning, 'effort')) result['reasoning.effort'] = level(body.reasoning.effort);
  if (own(body, 'enable_thinking')) result.enable_thinking = typeof body.enable_thinking === 'boolean' ? body.enable_thinking : '[invalid]';
  for (const [path, config] of [
    ['extra_body.google.thinking_config', body?.extra_body?.google?.thinking_config],
    ['google.thinking_config', body?.google?.thinking_config],
    ['thinking_config', body?.thinking_config],
    ['thinkingConfig', body?.thinkingConfig],
  ]) {
    for (const key of ['thinking_level', 'thinkingLevel']) {
      if (own(config, key)) result[`${path}.${key}`] = level(config[key]);
    }
    for (const key of ['thinking_budget', 'thinkingBudget']) {
      if (own(config, key)) {
        const value = config[key];
        result[`${path}.${key}`] = Number.isInteger(value) && value >= -1 && value <= 2_147_483_647 ? value : '[invalid]';
      }
    }
    for (const key of ['include_thoughts', 'includeThoughts']) {
      if (own(config, key)) result[`${path}.${key}`] = typeof config[key] === 'boolean' ? config[key] : '[invalid]';
    }
  }
  return result;
}

// Bounded in-memory copy only during an explicitly enabled diagnostic window.
// Bytes continue downstream immediately and are never reserialized.
export function reasoningObserver(report, contentEncoding, { includeRequestShape = false } = {}) {
  let chunks = [];
  let size = 0;
  let inspection = contentEncoding && contentEncoding !== 'identity' ? 'skipped_encoded' : 'ok';
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (inspection === 'ok') {
        size += chunk.length;
        if (size <= LIMIT) chunks.push(Buffer.from(chunk));
        else { inspection = 'skipped_too_large'; chunks = []; }
      }
      callback(null, chunk);
    },
    flush(callback) {
      let fields = {};
      let shape;
      if (inspection === 'ok') {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          fields = reasoningFields(body);
          if (includeRequestShape) shape = requestShape(body);
        }
        catch { inspection = 'invalid_json'; }
      }
      chunks = [];
      report({ inspection, fields, ...(shape ? { request_shape: shape } : {}), ...(inspection === 'ok' ? { present: Object.keys(fields).length > 0 } : {}) });
      callback();
    },
    destroy(error, callback) { chunks = []; callback(error); },
  });
}
