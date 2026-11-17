import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ResponsesError } from './responses-error.mjs';

const prefix = 'gcp1_';
const limit = 64 * 1024;
let cachedSecret;
let cachedKey;
function keyFor(secret) {
  if (secret !== cachedSecret) {
    cachedKey = createHash('sha256').update('gcp-bridge-provider-state-v1\0').update(secret).digest();
    cachedSecret = secret;
  }
  return cachedKey;
}
const aad = ({ model, callId, name }) => Buffer.from(JSON.stringify([model, callId, name]));

// Keep only the provider extension in authenticated opaque state, without server storage.
export function sealProviderState(extra, context) {
  if (!context?.key || !extra) return undefined;
  const plaintext = Buffer.from(JSON.stringify(extra));
  if (plaintext.length > limit) throw new ResponsesError('Upstream provider state is too large.', null, 'upstream_protocol_error', 502);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(context.key), nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openProviderState(value, context) {
  try {
    if (!context?.key || typeof value !== 'string' || !value.startsWith(prefix) || value.length > (limit + 28) * 2) throw new Error();
    const packed = Buffer.from(value.slice(prefix.length), 'base64url');
    if (packed.length < 29 || packed.length > limit + 28) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', keyFor(context.key), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    decipher.setAAD(aad(context));
    const extra = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'));
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error();
    return extra;
  } catch {
    throw new ResponsesError('Invalid provider state; keep the original model, call and Bridge key, or start a new conversation.', 'input.encrypted_content', 'invalid_provider_state');
  }
}

const callPrefix = 'gcp_call_';
export function providerCallId(callId, encryptedContent) {
  return encryptedContent ? callPrefix + Buffer.from(JSON.stringify([callId, encryptedContent])).toString('base64url') : callId;
}

// Some Codex versions omit encrypted_content when projecting tool history as well.
// call_id is preserved by every tool caller; keep its opaque provider state there too.
export function restoreProviderCall(value, context) {
  if (!value.startsWith(callPrefix)) return { callId: value };
  try {
    if (value.length > limit * 4) throw new Error();
    const [callId, encryptedContent] = JSON.parse(Buffer.from(value.slice(callPrefix.length), 'base64url').toString('utf8'));
    if (typeof callId !== 'string' || !callId.length) throw new Error();
    return { callId, extra: openProviderState(encryptedContent, { ...context, callId }) };
  } catch {
    throw new ResponsesError('Invalid provider tool call state; preserve the original call_id and Bridge key.', 'input.call_id', 'invalid_provider_state');
  }
}
