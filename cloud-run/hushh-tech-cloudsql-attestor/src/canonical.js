import { createHash } from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value) {
  return canonicalize(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}
