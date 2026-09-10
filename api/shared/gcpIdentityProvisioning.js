import { createHash } from "node:crypto";
import { readVerifiedFirebaseAccount } from "./gcpDataRuntime.js";

export function identityError(code, status = 409) {
  return Object.assign(new Error("Application identity could not be verified. Please contact support."), { code, status });
}

// Evidence is read from Firebase Admin, never from a browser profile or body.
// This encoding is versioned explicitly; activation requires a reviewed full
// ownership snapshot, including secondary and denied provider identities.
export async function prepareIdentityEvidence(actor, dependencies = {}) {
  if (!actor?.uid || actor.sub !== actor.uid || actor.aud !== "hushh-tech-uat" ||
      actor.iss !== "https://securetoken.google.com/hushh-tech-uat" || actor.firebase?.tenant) {
    throw identityError("AUTH_INVALID", 401);
  }
  let account;
  try {
    account = await (dependencies.readAccount || readVerifiedFirebaseAccount)(actor.uid);
  } catch (error) {
    if (["auth/user-not-found", "auth/user-disabled"].includes(error?.code)) throw identityError("AUTH_INVALID", 401);
    throw identityError("IDENTITY_SERVICE_UNAVAILABLE", 503);
  }
  if (!account || account.uid !== actor.uid || account.disabled || account.tenantId) throw identityError("AUTH_INVALID", 401);
  const created = Date.parse(account.metadata?.creationTime);
  if (!Number.isFinite(created) || created > Date.now()) throw identityError("IDENTITY_REVIEW_REQUIRED");
  const providers = (account.providerData || []).map((provider) => {
    if (!["google.com", "apple.com"].includes(provider.providerId) ||
        typeof provider.uid !== "string" || !provider.uid || provider.uid.length > 512 || provider.uid.includes("\u0000")) {
      return null;
    }
    const fingerprint = createHash("sha256")
      .update(`${provider.providerId}\u0000${provider.uid.normalize("NFC")}`, "utf8").digest("hex");
    return { providerId: provider.providerId, fingerprint };
  });
  // Existing mapped email/password users are still resolvable. The database
  // function refuses native creation when supported provider evidence is absent.
  return {
    createdAt: new Date(created).toISOString(),
    providers: providers.some((entry) => !entry) ? [] : providers,
    fingerprintScheme: "sha256-provider-nul-subject-nfc-v1",
  };
}

export async function ensureApplicationPrincipal(client, evidence) {
  try {
    const result = await client.query(
      "SELECT application_user_id, created FROM hushh_identity.ensure_current_application_principal($1::jsonb)",
      [JSON.stringify(evidence)],
    );
    if (result.rows.length !== 1 || !result.rows[0].application_user_id) throw identityError("IDENTITY_REVIEW_REQUIRED");
    return result.rows[0];
  } catch (error) {
    // The function emits fixed error codes, never provider or account values.
    if (error?.code === "P0001" && ["IDENTITY_REVIEW_REQUIRED", "IDENTITY_DENIED", "IDENTITY_CREATION_DISABLED", "IDENTITY_EVIDENCE_UNAVAILABLE"].includes(error.message)) {
      throw identityError(error.message, error.message === "IDENTITY_DENIED" ? 403 : error.message.includes("DISABLED") || error.message.includes("UNAVAILABLE") ? 503 : 409);
    }
    throw error;
  }
}
