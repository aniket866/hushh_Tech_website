import { canonicalHash } from "./canonical.js";
import { MAX_POLICY_COUNT } from "./constants.js";
import { AttestorError } from "./errors.js";

const COMMANDS = Object.freeze({
  r: "SELECT",
  a: "INSERT",
  w: "UPDATE",
  d: "DELETE",
  "*": "ALL",
});
const CANONICAL_COMMANDS = new Set(Object.values(COMMANDS));
const POLICY_KEYS = Object.freeze([
  "schema",
  "table",
  "policyName",
  "command",
  "roles",
  "permissive",
  "usingExpression",
  "withCheckExpression",
]);
const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:postgres(?:ql)?|https?|wss?):\/\/|\b(?:sk_live_|sk_test_|sb_secret_|ghp_|github_pat_)[A-Za-z0-9_-]{12,})/i;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeSqlExpression(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new AttestorError("POLICY_EVIDENCE_INVALID");
  const source = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  let output = "";
  let whitespace = false;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === quote) {
        if (source[index + 1] === quote) {
          output += source[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (whitespace && output) output += " ";
      whitespace = false;
      quote = character;
      output += character;
    } else if (/\s/.test(character)) {
      whitespace = true;
    } else {
      const previous = output.at(-1);
      const separatedByPunctuation =
        previous && /[([{.,]/.test(previous) || /[)\]},.;]/.test(character) || character === "(";
      if (whitespace && output && !separatedByPunctuation) output += " ";
      whitespace = false;
      output += character;
    }
  }
  return output.trim();
}

function policyIdentity(policy) {
  return `${policy.schema}.${policy.table}.${policy.policyName}`;
}

function semanticPolicy(policy) {
  return {
    command: policy.command,
    roles: policy.roles,
    permissive: policy.permissive,
    usingExpression: policy.usingExpression,
    withCheckExpression: policy.withCheckExpression,
  };
}

export function normalizePolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AttestorError("POLICY_EVIDENCE_INVALID");
  }
  const command = COMMANDS[raw.command] ??
    (CANONICAL_COMMANDS.has(raw.command) ? raw.command : null);
  const roles = raw.roles;
  if (
    typeof raw.schema !== "string" ||
    typeof raw.table !== "string" ||
    typeof raw.policyName !== "string" ||
    !command ||
    !Array.isArray(roles) ||
    roles.some((role) => typeof role !== "string") ||
    new Set(roles).size !== roles.length ||
    typeof raw.permissive !== "boolean"
  ) {
    throw new AttestorError("POLICY_EVIDENCE_INVALID");
  }
  const policy = {
    schema: raw.schema,
    table: raw.table,
    policyName: raw.policyName,
    command,
    roles: [...roles].sort(),
    permissive: raw.permissive,
    usingExpression: normalizeSqlExpression(raw.usingExpression),
    withCheckExpression: normalizeSqlExpression(raw.withCheckExpression),
  };
  if (
    Object.values(policy).some((value) => typeof value === "string" && SECRET_PATTERN.test(value)) ||
    policy.roles.some((role) => SECRET_PATTERN.test(role))
  ) {
    throw new AttestorError("POLICY_EVIDENCE_SENSITIVE");
  }
  return Object.freeze(policy);
}

export function canonicalPolicies(policies) {
  if (!Array.isArray(policies) || policies.length > MAX_POLICY_COUNT) {
    throw new AttestorError("POLICY_EVIDENCE_LIMIT_EXCEEDED");
  }
  const normalized = policies.map(normalizePolicy).sort((left, right) =>
    policyIdentity(left).localeCompare(policyIdentity(right)),
  );
  const identities = new Set();
  for (const policy of normalized) {
    const identity = policyIdentity(policy);
    if (identities.has(identity)) throw new AttestorError("POLICY_EVIDENCE_DUPLICATE");
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

export function buildPolicyEvidence(policies) {
  const canonical = canonicalPolicies(policies);
  return Object.freeze({
    count: canonical.length,
    hash: canonicalHash(canonical),
    policies: canonical,
  });
}

export function comparePolicySets(expected, observed) {
  const actual = canonicalPolicies(observed);
  if (expected === null) {
    return Object.freeze({
      mode: "aggregate-only",
      matched: null,
      expectedOnly: null,
      observedOnly: null,
      drifted: null,
    });
  }
  const baseline = canonicalPolicies(expected);
  const expectedByIdentity = new Map(baseline.map((policy) => [policyIdentity(policy), policy]));
  const observedByIdentity = new Map(actual.map((policy) => [policyIdentity(policy), policy]));
  const matched = [];
  const expectedOnly = [];
  const observedOnly = [];
  const drifted = [];
  for (const [identity, policy] of expectedByIdentity) {
    const live = observedByIdentity.get(identity);
    if (!live) {
      expectedOnly.push(identity);
      continue;
    }
    const differences = {
      commandChanged: policy.command !== live.command,
      rolesChanged: canonicalHash(policy.roles) !== canonicalHash(live.roles),
      permissiveChanged: policy.permissive !== live.permissive,
      usingChanged: policy.usingExpression !== live.usingExpression,
      withCheckChanged: policy.withCheckExpression !== live.withCheckExpression,
    };
    if (Object.values(differences).some(Boolean)) drifted.push({ identity, differences });
    else matched.push(identity);
  }
  for (const identity of observedByIdentity.keys()) {
    if (!expectedByIdentity.has(identity)) observedOnly.push(identity);
  }
  return Object.freeze({
    mode: "exact",
    matched: matched.sort(),
    expectedOnly: expectedOnly.sort(),
    observedOnly: observedOnly.sort(),
    drifted: drifted.sort((left, right) => left.identity.localeCompare(right.identity)),
  });
}

export function validatePolicyEvidence(value) {
  if (!exactKeys(value, ["count", "hash", "policies"]) || value.count !== value.policies?.length) {
    throw new AttestorError("POLICY_EVIDENCE_INVALID");
  }
  const canonical = buildPolicyEvidence(value.policies);
  if (canonical.count !== value.count || canonical.hash !== value.hash) {
    throw new AttestorError("POLICY_EVIDENCE_INVALID");
  }
  return true;
}

export { POLICY_KEYS, policyIdentity, semanticPolicy };
