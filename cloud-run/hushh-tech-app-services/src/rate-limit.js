import { RuntimeError } from "./errors.js";

export function createRateLimiter({
  limit,
  windowMs = 60_000,
  maxKeys = 5_000,
  now = Date.now,
} = {}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(maxKeys) ||
    maxKeys < 1
  ) {
    throw new Error("A bounded rate-limit contract is required.");
  }
  const buckets = new Map();

  function prune(timestamp) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }

  return function enforceRateLimit(key) {
    const timestamp = now();
    const windowStart = Math.floor(timestamp / windowMs) * windowMs;
    const resetAt = windowStart + windowMs;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt !== resetAt) {
      if (buckets.size >= maxKeys) prune(timestamp);
      if (buckets.size >= maxKeys && !buckets.has(key)) {
        throw new RuntimeError("RATE_LIMITED", "Try again later.", 429);
      }
      bucket = { count: 0, resetAt };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw new RuntimeError("RATE_LIMITED", "Try again later.", 429);
    }
    return Object.freeze({
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    });
  };
}
