import { RuntimeError } from "./errors.js";

function unavailable(error) {
  if (
    error instanceof RuntimeError &&
    error.code === "SHARED_RATE_LIMIT_UNAVAILABLE"
  ) {
    return error;
  }
  return new RuntimeError(
    "SHARED_RATE_LIMIT_UNAVAILABLE",
    "Service unavailable.",
    503,
    error ? { cause: error } : {},
  );
}

export function createUnavailableSharedRateLimiter() {
  const reject = async () => {
    throw unavailable();
  };
  return Object.freeze({ consume: reject, verifyReady: reject });
}

export async function verifySharedRateLimiter(limiter) {
  if (!limiter || typeof limiter.verifyReady !== "function") {
    throw unavailable();
  }
  let ready;
  try {
    ready = await limiter.verifyReady();
  } catch (error) {
    throw unavailable(error);
  }
  if (ready !== true) throw unavailable();
  return true;
}

export async function consumeSharedRateLimit(limiter, input) {
  if (!limiter || typeof limiter.consume !== "function") {
    throw unavailable();
  }
  if (input?.signal?.aborted) {
    throw input.signal.reason ?? unavailable();
  }
  let result;
  try {
    result = await limiter.consume(Object.freeze({ ...input }));
  } catch (error) {
    if (input?.signal?.aborted && error === input.signal.reason) throw error;
    throw unavailable(error);
  }
  if (input?.signal?.aborted) {
    throw input.signal.reason ?? unavailable();
  }
  if (result?.allowed === false) {
    throw new RuntimeError("RATE_LIMITED", "Try again later.", 429);
  }
  if (result?.allowed !== true) throw unavailable();
  return Object.freeze({ allowed: true });
}
