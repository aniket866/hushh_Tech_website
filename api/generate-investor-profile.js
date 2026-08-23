/**
 * Server-side investor profile generation for the Cloud Run web runtime.
 * Keeps AI keys out of the browser and returns the existing profile contract.
 */

import { GoogleGenAI } from "@google/genai";
import { createGcpServerClient } from "./shared/gcpServerClient.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_LOCATION = "us-central1";
const PROVIDER_VERTEX = "vertex";
const PROVIDER_API_KEY = "api-key";
const USER_SAFE_UPSTREAM_ERROR =
  "Investor profile intelligence is temporarily unavailable. Please try again shortly.";

const SYSTEM_PROMPT = `You are an assistant that PRE-FILLS an INVESTOR PROFILE from minimal information.

You are given:
- raw user inputs: name, phone (with country code), email, age, organisation
- derived_context: country, region, currency, email_type, company_industry, life_stage, org_type
- financial_context (optional, from verified bank data via Plaid): nws_score (0-100), nws_tier, total_cash_balance, total_investment_value, num_accounts, account_types, address, identity_verification_score

GOALS:
1. For each of 12 profile fields, GUESS a reasonable default value based on general demographic and behavioral patterns of high-net-worth investors.
2. For each field, return:
   - value: the selected option (must match exactly from allowed values)
   - confidence: 0.0-1.0 (how confident you are in this guess)
   - rationale: 1-2 sentences explaining your reasoning

3. Be conservative and privacy-first:
   - Never claim to know actual income, net worth, or legal accreditation
   - Use only the provided context and typical statistical patterns
   - Younger investors (20s-30s) often have longer time horizons (>10 years)
   - Tech/finance roles often correlate with higher risk tolerance (moderate to high)
   - Life stage influences liquidity needs and investment capacity
   - Investment sizes are in MILLIONS: micro_<1m means under $1 million, small_1m_10m means $1-10 million, etc.
   - Annual capacity is in MILLIONS: <5m means under $5 million per year, 5m_20m means $5-20 million per year, etc.
   - These are high-net-worth investor profiles with institutional-scale investment capacity

4. If financial_context is provided (verified bank data), use it to improve accuracy:
   - NWS score 80+ (Elite) -> higher risk tolerance, larger ticket sizes, advanced experience
   - NWS score 60-79 (Strong) -> moderate-high risk, medium-large tickets
   - NWS score 40-59 (Moderate) -> moderate risk, small-medium tickets
   - NWS score <40 (Building) -> conservative, micro-small tickets
   - Use total_cash_balance + total_investment_value to calibrate annual_investing_capacity
   - Account types (401k, brokerage, etc.) indicate experience level
   - Set confidence 0.7-0.9 for fields informed by real financial data

5. If you have no clear signal, choose the SAFEST neutral option and set confidence <= 0.3.

6. For multi-select fields (asset_class_preference, sector_preferences), return 2-4 relevant items.

OUTPUT REQUIREMENTS:
- Must be valid JSON only, no comments, no extra text
- Use option values EXACTLY as specified in the schema (with million-scale values like micro_<1m, small_1m_10m, etc.)
- All 12 fields must be present
- Each field must have: value, confidence, rationale
- Confidence must be between 0.0 and 1.0
- Return the profile under key "investor_profile"`;

const PROFILE_SCHEMA = {
  primary_goal: {
    options: [
      "capital_preservation",
      "steady_income",
      "long_term_growth",
      "aggressive_growth",
      "speculation",
    ],
  },
  investment_horizon_years: {
    options: ["<3_years", "3_5_years", "5_10_years", ">10_years"],
  },
  risk_tolerance: {
    options: ["very_low", "low", "moderate", "high", "very_high"],
  },
  liquidity_need: {
    options: ["low", "medium", "high"],
  },
  experience_level: {
    options: ["beginner", "intermediate", "advanced"],
  },
  typical_ticket_size: {
    options: ["micro_<1m", "small_1m_10m", "medium_10m_50m", "large_>50m"],
  },
  annual_investing_capacity: {
    options: ["<5m", "5m_20m", "20m_100m", ">100m"],
  },
  asset_class_preference: {
    options: [
      "public_equities",
      "mutual_funds_etfs",
      "fixed_income",
      "real_estate",
      "startups_private_equity",
      "crypto_digital_assets",
      "cash_equivalents",
    ],
  },
  sector_preferences: {
    options: [
      "technology",
      "consumer_internet",
      "fintech",
      "healthcare",
      "real_estate",
      "energy_climate",
      "industrial",
      "other",
    ],
  },
  volatility_reaction: {
    options: [
      "sell_to_avoid_more_loss",
      "hold_and_wait",
      "buy_more_at_lower_prices",
    ],
  },
  sustainability_preference: {
    options: ["not_important", "nice_to_have", "important", "very_important"],
  },
  engagement_style: {
    options: [
      "very_passive_just_updates",
      "collaborative_discuss_key_decisions",
      "hands_on_active_trader",
    ],
  },
};

let keyIndex = 0;

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getBearerToken(req) {
  const raw = trimValue(req.headers?.authorization || req.headers?.Authorization);
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
}

function getGeminiKeys(env = process.env) {
  return [
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
  ]
    .map(trimValue)
    .filter(Boolean);
}

function getModel(env = process.env) {
  return trimValue(env.GEMINI_INVESTOR_PROFILE_MODEL) || DEFAULT_MODEL;
}

function getGeminiProvider(env = process.env) {
  const configured = trimValue(env.GEMINI_INVESTOR_PROFILE_PROVIDER).toLowerCase();
  if (["vertex", "vertexai", "vertex-ai"].includes(configured)) {
    return PROVIDER_VERTEX;
  }
  if (["api-key", "apikey", "developer", "developer-api"].includes(configured)) {
    return PROVIDER_API_KEY;
  }
  if (trimValue(env.GOOGLE_GENAI_USE_VERTEXAI).toLowerCase() === "true") {
    return PROVIDER_VERTEX;
  }
  return getGeminiKeys(env).length > 0 ? PROVIDER_API_KEY : PROVIDER_VERTEX;
}

function getVertexConfig(env = process.env) {
  const project =
    trimValue(env.GOOGLE_CLOUD_PROJECT) ||
    trimValue(env.GCP_PROJECT_ID) ||
    trimValue(env.GCLOUD_PROJECT);
  const location = trimValue(env.GOOGLE_CLOUD_LOCATION) || DEFAULT_LOCATION;

  if (!project) {
    return null;
  }

  return { project, location };
}

function getProviderOrder(env = process.env) {
  const primary = getGeminiProvider(env);
  return primary === PROVIDER_VERTEX
    ? [PROVIDER_VERTEX, PROVIDER_API_KEY]
    : [PROVIDER_API_KEY, PROVIDER_VERTEX];
}

function getGcpBackendConfig(env = process.env) {
  const gcpBackendUrl = trimValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME) || trimValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME);
  const serviceRoleKey = trimValue(env.GCP_SERVER_ACTOR_UID);

  if (!gcpBackendUrl || !serviceRoleKey) {
    const error = new Error("Profile authentication is not configured on server");
    error.statusCode = 503;
    throw error;
  }

  return { gcpBackendUrl, serviceRoleKey };
}

async function authenticateRequest(req, env = process.env) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error("Missing authorization header");
    error.statusCode = 401;
    throw error;
  }

  const { gcpBackendUrl, serviceRoleKey } = getGcpBackendConfig(env);
  const client = createGcpServerClient(gcpBackendUrl, serviceRoleKey);
  const { data, error } = await client.auth.getUser(token);

  if (error || !data?.user) {
    const authError = new Error("Unauthorized - invalid token");
    authError.statusCode = 401;
    throw authError;
  }

  return data.user;
}

function buildPromptPayload(input, context) {
  const { financial_context, ...derivedContext } = context;
  const payload = {
    raw_input: {
      name: input.name,
      email: input.email,
      age: input.age,
      phone_country_code: input.phone_country_code,
      phone_number: input.phone_number,
      organisation: input.organisation || null,
    },
    derived_context: derivedContext,
    profile_schema: PROFILE_SCHEMA,
  };

  if (financial_context) {
    payload.financial_context = financial_context;
  }

  return JSON.stringify(payload, null, 2);
}

async function extractResponseText(response) {
  if (typeof response?.text === "string") {
    return response.text;
  }

  if (typeof response?.text === "function") {
    return await response.text();
  }

  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => part?.text || "").join("");
  }

  return "";
}

function cleanJsonText(text) {
  const withoutFence = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const firstOpen = withoutFence.indexOf("{");
  const lastClose = withoutFence.lastIndexOf("}");
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    return withoutFence.slice(firstOpen, lastClose + 1);
  }
  return withoutFence;
}

function parseProfileResponse(text) {
  const parsed = JSON.parse(cleanJsonText(text));
  return parsed.investor_profile || parsed;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return ["investor_profile"];
  }

  return Object.keys(PROFILE_SCHEMA).filter((field) => {
    const fieldValue = profile[field];
    return !fieldValue || typeof fieldValue !== "object" || fieldValue.value === undefined;
  });
}

async function runGeminiRequest(ai, userPrompt, model) {
  const response = await ai.models.generateContent({
    model,
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });
  return extractResponseText(response);
}

function logGeminiError(provider, error) {
  console.error("Gemini investor profile generation failed:", {
    provider,
    code: error?.code,
    status: error?.status,
    message: error?.message || String(error),
  });
}

async function generateWithApiKeyGemini(userPrompt, model, env = process.env) {
  const keys = getGeminiKeys(env);
  if (keys.length === 0) {
    return { skipped: true, reason: "missing Gemini API key" };
  }

  const startIndex = keyIndex % keys.length;
  keyIndex = (keyIndex + 1) % keys.length;
  let lastError;

  for (let offset = 0; offset < keys.length; offset += 1) {
    const apiKey = keys[(startIndex + offset) % keys.length];
    try {
      const ai = new GoogleGenAI({ apiKey });
      return { text: await runGeminiRequest(ai, userPrompt, model) };
    } catch (error) {
      lastError = error;
      logGeminiError(PROVIDER_API_KEY, error);
    }
  }

  return { error: lastError };
}

async function generateWithVertexGemini(userPrompt, model, env = process.env) {
  const config = getVertexConfig(env);
  if (!config) {
    return { skipped: true, reason: "missing Google Cloud project" };
  }

  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
      apiVersion: "v1",
    });
    return { text: await runGeminiRequest(ai, userPrompt, model) };
  } catch (error) {
    logGeminiError(PROVIDER_VERTEX, error);
    return { error };
  }
}

async function generateWithGemini(userPrompt, env = process.env) {
  const model = getModel(env);
  let attempted = false;
  let lastError;

  for (const provider of getProviderOrder(env)) {
    const result =
      provider === PROVIDER_VERTEX
        ? await generateWithVertexGemini(userPrompt, model, env)
        : await generateWithApiKeyGemini(userPrompt, model, env);

    if (result?.skipped) {
      continue;
    }

    attempted = true;

    if (result?.text !== undefined) {
      return result.text;
    }

    if (result?.error) {
      lastError = result.error;
    }
  }

  if (!attempted) {
    const error = new Error("Investor profile AI is not configured on server");
    error.statusCode = 500;
    throw error;
  }

  const upstreamError = new Error(USER_SAFE_UPSTREAM_ERROR);
  upstreamError.statusCode = 502;
  upstreamError.cause = lastError;
  throw upstreamError;
}

function sendCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization",
  );
}

export default async function handler(req, res) {
  sendCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    await authenticateRequest(req);

    const { input, context } = req.body || {};
    if (!input || !context) {
      return res.status(400).json({ error: "Missing required fields: input and context" });
    }

    const responseText = await generateWithGemini(buildPromptPayload(input, context));
    if (!responseText) {
      console.error("Empty Gemini response for investor profile");
      return res.status(502).json({ error: USER_SAFE_UPSTREAM_ERROR });
    }

    let profile;
    try {
      profile = parseProfileResponse(responseText);
    } catch (error) {
      console.error("Failed to parse Gemini investor profile JSON:", error);
      return res.status(502).json({ error: USER_SAFE_UPSTREAM_ERROR });
    }

    const missingFields = validateProfile(profile);
    if (missingFields.length > 0) {
      console.error("Missing fields in Gemini profile response:", missingFields);
      return res.status(502).json({
        error: `Missing required fields in AI response: ${missingFields.join(", ")}`,
      });
    }

    return res.status(200).json({
      success: true,
      profile,
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    const message =
      status === 502
        ? USER_SAFE_UPSTREAM_ERROR
        : error?.message || "Failed to generate investor profile";
    console.error("Error generating investor profile:", error);
    return res.status(status).json({ error: message });
  }
}
