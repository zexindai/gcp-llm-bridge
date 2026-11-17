export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function json(res, status, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

export function redact(value, ...secrets) {
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value;
}
