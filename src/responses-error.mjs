export class ResponsesError extends Error {
  constructor(message, param = null, code = 'invalid_request', status = 400) {
    super(message);
    Object.assign(this, { param, code, status });
  }
}
