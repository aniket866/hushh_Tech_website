import { createHash } from "node:crypto";

import { RuntimeError } from "../errors.js";

const GCS_DOWNLOAD_ORIGIN = "https://storage.googleapis.com";
const VERTEX_LOCATION = "us-central1";
const VERTEX_MODEL = "gemini-2.5-flash";
const ALLOWED_PROJECTS = new Set(["hushh-tech-uat", "hushh-tech-prod"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const GCS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const LOCATION_CODE_PATTERN = /^[A-Z0-9-]{1,8}$/;
const MAX_CATALOG_BYTES = 25 * 1024 * 1024;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return database;
}

function requireFundAdminActor(actor) {
  if (
    actor?.kind !== "firebase" ||
    actor?.fundAdmin !== true ||
    typeof actor?.uid !== "string" ||
    !actor.uid
  ) {
    throw new RuntimeError("FUND_ADMIN_REQUIRED", "Access denied.", 403);
  }
  return actor;
}

async function rows(client, text, values = []) {
  const result = await client.query(text, values);
  if (!result || !Array.isArray(result.rows)) {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return result.rows;
}

async function optionalRows(client, savepoint, table, text, warnings) {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await rows(client, text);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    warnings.push({
      source: table,
      code: "SOURCE_UNAVAILABLE",
      message: "Optional source is unavailable",
    });
    return [];
  }
}

async function bestEffortAdminAudit(client, actor, targetReference) {
  await client.query("SAVEPOINT admin_audit_write");
  try {
    await client.query(
      `INSERT INTO public.fund_admin_access_log
         (actor_user_id, actor_email, action, target_reference, metadata,
          ip_address, user_agent)
       VALUES ($1, $2, 'view_overview', $3, '{}'::jsonb, NULL, NULL)`,
      [actor.uid, actor.email ?? null, targetReference ?? null],
    );
    await client.query("RELEASE SAVEPOINT admin_audit_write");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT admin_audit_write");
    await client.query("RELEASE SAVEPOINT admin_audit_write");
  }
}

export function createCloudSqlReadBatchAdapter() {
  return Object.freeze({
    async chatAccess({ database, visitorId, slug, now, signal }) {
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || chr(0) || $2, 0))",
          [visitorId, slug],
        );
        let matches = await rows(
          client,
          `SELECT id, access_type, expires_at, messages_limit,
                  messages_sent_count, hourly_message_count, hourly_reset_at
             FROM public.chat_access_tokens
            WHERE visitor_id = $1 AND profile_slug = $2
            ORDER BY id
            LIMIT 2
            FOR UPDATE`,
          [visitorId, slug],
        );
        if (matches.length > 1) {
          throw new RuntimeError(
            "DATA_INTEGRITY_ERROR",
            "Service unavailable.",
            503,
          );
        }
        if (matches.length === 0) {
          matches = await rows(
            client,
            `INSERT INTO public.chat_access_tokens
               (visitor_id, profile_slug, payment_status, access_type,
                messages_limit, messages_sent_count, ip_address, user_agent)
             VALUES ($1, $2, 'free_tier', 'free', 3, 0, NULL, NULL)
             RETURNING id, access_type, expires_at, messages_limit,
                       messages_sent_count, hourly_message_count,
                       hourly_reset_at`,
            [visitorId, slug],
          );
        }
        const token = matches[0];
        if (token?.access_type === "paid") {
          const resetAt = Date.parse(token.hourly_reset_at ?? now.toISOString());
          if (Number.isFinite(resetAt) && now.getTime() > resetAt) {
            await client.query(
              `UPDATE public.chat_access_tokens
                  SET hourly_message_count = 0,
                      hourly_reset_at = $2
                WHERE id = $1`,
              [token.id, new Date(now.getTime() + 3_600_000).toISOString()],
            );
            token.hourly_message_count = 0;
          }
        }
        throwIfAborted(signal);
        return token;
      });
    },

    async publicInvestorProfile({ database, slug, signal }) {
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        const matches = await rows(
          client,
          `SELECT name, age, organisation, investor_profile, slug
             FROM public.investor_profiles
            WHERE slug = $1
              AND is_public IS TRUE
              AND user_confirmed IS TRUE
            LIMIT 2`,
          [slug],
        );
        return matches.length === 1 ? matches[0] : null;
      });
    },

    async overview({
      database,
      actor,
      targetReference = null,
      includeUsers = true,
      signal,
    }) {
      requireFundAdminActor(actor);
      if (typeof includeUsers !== "boolean") {
        throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
      }
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        await bestEffortAdminAudit(client, actor, targetReference);
        const sourceWarnings = [];
        const output = {
          paymentRows: await rows(client, `SELECT id, user_id, request_reference,
            selected_fund, status, commitment_amount, first_payment_amount,
            class_a_units, class_b_units, class_c_units, risk_flags, paid_at,
            verified_at, rejected_at, reviewer_user_id, created_at
            FROM public.fund_stripe_payment_requests`),
          ndaRows: await rows(client, `SELECT user_id, signer_name, signed_at
            FROM public.nda_signatures WHERE signed_at IS NOT NULL`),
          ceoRows: await rows(client, `SELECT user_id, payment_status,
            calendly_booked, created_at FROM public.ceo_meeting_payments
            WHERE payment_status = 'completed'`),
          onboardingRows: await rows(client, `SELECT user_id, legal_first_name,
            legal_last_name, current_step, is_completed, completed_at,
            fund_payment_status, fund_investor_verification_status,
            financial_link_status, nda_signed_at, initial_investment_amount,
            selected_fund, class_a_units, class_b_units, class_c_units,
            updated_at
            FROM public.onboarding_data`),
          paidRows: await rows(client, `SELECT user_id, amount, status
            FROM public.fund_stripe_payments WHERE status = 'succeeded'`),
          financialRows: await rows(client, `SELECT user_id, institution_name,
            status, plaid_sync_status, plaid_item_id,
            plaid_sync_completed_at, updated_at
            FROM public.user_financial_data`),
          itemRows: await rows(client, `SELECT user_id, plaid_item_id,
            institution_name, status, updated_at FROM public.plaid_items`),
          accountRows: await rows(client, `SELECT plaid_item_id,
            plaid_account_id, name, official_name, type, subtype, mask,
            current_balance FROM public.plaid_accounts`),
          productRows: await rows(client, `SELECT user_id, plaid_item_id,
            product, status, available, records_count, updated_at, completed_at
            FROM public.plaid_product_sync_statuses`),
          userRows: includeUsers
            ? await rows(client, "SELECT id, email FROM public.users")
            : [],
        };
        output.kycRows = await optionalRows(
          client,
          "optional_kyc_overview",
          "kyc_attestations",
          `SELECT user_id, status, risk_band, risk_score, verified_at,
                  provider_name FROM public.kyc_attestations
            ORDER BY verified_at DESC`,
          sourceWarnings,
        );
        output.sourceWarnings = sourceWarnings;
        throwIfAborted(signal);
        return output;
      });
    },

    async analytics({ database, actor, signal }) {
      requireFundAdminActor(actor);
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        const sourceWarnings = [];
        const output = {
          paymentRows: await rows(client, `SELECT user_id, selected_fund,
            status, commitment_amount, first_payment_amount, class_a_units,
            class_b_units, class_c_units, recurring_selected,
            recurring_amount, paid_at, verified_at, rejected_at, created_at
            FROM public.fund_stripe_payment_requests`),
          ndaRows: await rows(client, `SELECT user_id, signed_at
            FROM public.nda_signatures WHERE signed_at IS NOT NULL`),
          onboardingRows: await rows(client, `SELECT user_id, is_completed,
            completed_at, financial_link_status, selected_fund
            FROM public.onboarding_data`),
          paidRows: await rows(client, `SELECT user_id, amount_cents, status,
            payment_kind, paid_at, created_at FROM public.fund_stripe_payments
            WHERE status = 'succeeded'`),
          financialRows: await rows(client, `SELECT user_id, status,
            plaid_sync_status, plaid_item_id FROM public.user_financial_data`),
          ceoRows: await rows(client, `SELECT user_id, payment_status
            FROM public.ceo_meeting_payments
            WHERE payment_status = 'completed'`),
          subscriptionRows: await rows(client, `SELECT user_id, status,
            recurring_amount, recurring_frequency
            FROM public.fund_stripe_subscriptions`),
        };
        output.kycRows = await optionalRows(
          client,
          "optional_kyc_analytics",
          "kyc_attestations",
          "SELECT user_id, status, risk_band FROM public.kyc_attestations",
          sourceWarnings,
        );
        output.sourceWarnings = sourceWarnings;
        throwIfAborted(signal);
        return output;
      });
    },
  });
}

function validateLocationCatalog(value) {
  if (!value || !Array.isArray(value.countries) || value.countries.length < 1) {
    throw new Error("Location catalog is invalid.");
  }
  const countries = [];
  const seenCountries = new Set();
  for (const country of value.countries) {
    const isoCode = clean(country?.isoCode).toUpperCase();
    const name = clean(country?.name);
    if (
      !LOCATION_CODE_PATTERN.test(isoCode) ||
      !name ||
      name.length > 128 ||
      seenCountries.has(isoCode) ||
      !Array.isArray(country?.states)
    ) {
      throw new Error("Location catalog is invalid.");
    }
    seenCountries.add(isoCode);
    const states = [];
    const seenStates = new Set();
    for (const state of country.states) {
      const stateCode = clean(state?.isoCode).toUpperCase();
      const stateName = clean(state?.name);
      if (
        !LOCATION_CODE_PATTERN.test(stateCode) ||
        !stateName ||
        stateName.length > 128 ||
        seenStates.has(stateCode) ||
        !Array.isArray(state?.cities)
      ) {
        throw new Error("Location catalog is invalid.");
      }
      seenStates.add(stateCode);
      const cities = state.cities.map((city) => clean(city));
      if (
        cities.some((city) => !city || city.length > 160) ||
        new Set(cities).size !== cities.length
      ) {
        throw new Error("Location catalog is invalid.");
      }
      states.push(Object.freeze({
        isoCode: stateCode,
        name: stateName,
        cities: Object.freeze(cities),
      }));
    }
    countries.push(Object.freeze({
      isoCode,
      name,
      states: Object.freeze(states),
    }));
  }
  return Object.freeze(countries);
}

export function createStaticLocationCatalogAdapter(catalog) {
  const countries = validateLocationCatalog(catalog);
  const byCountry = new Map(countries.map((country) => [country.isoCode, country]));
  return Object.freeze({
    configured: true,
    countries() {
      return countries.map(({ isoCode, name }) => ({ isoCode, name }));
    },
    states(countryCode) {
      return (byCountry.get(countryCode)?.states ?? []).map(({ isoCode, name }) => ({
        isoCode,
        name,
      }));
    },
    cities(countryCode, stateCode) {
      const state = byCountry
        .get(countryCode)
        ?.states.find((candidate) => candidate.isoCode === stateCode);
      return (state?.cities ?? []).map((name) => ({ name }));
    },
  });
}

export function createGcsLocationCatalogAdapter({
  fetchImpl = globalThis.fetch,
  getAccessToken,
  bucket,
  object,
  generation,
  sha256,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function" ||
    !GCS_NAME_PATTERN.test(clean(bucket)) ||
    !clean(object) ||
    clean(object).length > 1_024 ||
    !/^[1-9][0-9]{0,30}$/.test(clean(generation)) ||
    !HASH_PATTERN.test(clean(sha256))
  ) {
    throw new Error("Pinned GCS location catalog configuration is required.");
  }
  let loaded = null;
  async function load(signal) {
    if (loaded) return loaded;
    const token = clean(await getAccessToken());
    if (!token) throw new Error("GCS identity token is unavailable.");
    const url = new URL(
      `/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`,
      GCS_DOWNLOAD_ORIGIN,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", generation);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Location catalog is unavailable.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length > MAX_CATALOG_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error("Location catalog integrity check failed.");
    }
    loaded = createStaticLocationCatalogAdapter(JSON.parse(bytes.toString("utf8")));
    return loaded;
  }
  return Object.freeze({
    configured: true,
    async countries(signal) {
      return (await load(signal)).countries();
    },
    async states(countryCode, signal) {
      return (await load(signal)).states(countryCode);
    },
    async cities(countryCode, stateCode, signal) {
      return (await load(signal)).cities(countryCode, stateCode);
    },
  });
}

export function createVertexInvestorProfileAdapter({
  fetchImpl = globalThis.fetch,
  getAccessToken,
  projectId,
  location = VERTEX_LOCATION,
  model = VERTEX_MODEL,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function" ||
    !ALLOWED_PROJECTS.has(projectId) ||
    location !== VERTEX_LOCATION ||
    model !== VERTEX_MODEL
  ) {
    throw new Error("Pinned Vertex AI configuration is required.");
  }
  const endpoint = new URL(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`,
  );
  return Object.freeze({
    configured: true,
    async generate({ systemInstruction, prompt, signal }) {
      const token = clean(await getAccessToken());
      if (!token) throw new Error("Vertex AI identity token is unavailable.");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4_096,
            responseMimeType: "application/json",
          },
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Vertex AI request failed.");
      const payload = await response.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => clean(part?.text))
        .filter(Boolean)
        .join("");
      if (!text) throw new Error("Vertex AI response was empty.");
      return text;
    },
  });
}

export const GCP_READ_BATCH_ADAPTER_LIMITS = Object.freeze({
  maxCatalogBytes: MAX_CATALOG_BYTES,
  vertexLocation: VERTEX_LOCATION,
  vertexModel: VERTEX_MODEL,
});
