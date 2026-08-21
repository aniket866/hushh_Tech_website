export class RuntimeError extends Error {
  constructor(code, message, statusCode, options = {}) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function asRuntimeError(error) {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError(
    "INTERNAL_ERROR",
    "Service unavailable.",
    503,
    { cause: error },
  );
}

export function errorPayload(error, requestId) {
  return Object.freeze({
    detail: Object.freeze({
      code: error.code,
      message: error.message,
      request_id: requestId,
    }),
  });
}
