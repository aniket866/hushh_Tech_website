import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const getUser = vi.fn();
const createClient = vi.fn(() => ({
  auth: { getUser },
}));
// `api/generate-investor-profile.js` does `new GoogleGenAI(...)`. An arrow function is not a
// constructor, and vitest 4 invokes a mock implementation as one rather than quietly tolerating
// it, so this has to be a real function. Under vitest 3 the same mock threw inside the route and
// surfaced as a 502 only after the bump.
const GoogleGenAI = vi.fn(function createGoogleGenAI() {
  return { models: { generateContent } };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI,
}));

vi.mock("../api/shared/gcpServerClient.js", () => ({
  createGcpServerClient: createClient,
}));

const createResponse = () => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: any;
  let ended = false;

  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get ended() {
      return ended;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return this;
    },
    end() {
      ended = true;
      return this;
    },
  };
};

const validProfile = {
  primary_goal: { value: "long_term_growth", confidence: 0.7, rationale: "Long horizon." },
  investment_horizon_years: { value: ">10_years", confidence: 0.7, rationale: "Young investor." },
  risk_tolerance: { value: "moderate", confidence: 0.6, rationale: "Balanced signals." },
  liquidity_need: { value: "medium", confidence: 0.5, rationale: "Default liquidity." },
  experience_level: { value: "intermediate", confidence: 0.6, rationale: "Professional context." },
  typical_ticket_size: { value: "micro_<1m", confidence: 0.5, rationale: "Conservative default." },
  annual_investing_capacity: { value: "<5m", confidence: 0.5, rationale: "Conservative default." },
  asset_class_preference: {
    value: ["public_equities", "mutual_funds_etfs"],
    confidence: 0.6,
    rationale: "Liquid diversified options.",
  },
  sector_preferences: {
    value: ["technology", "fintech"],
    confidence: 0.6,
    rationale: "Professional context.",
  },
  volatility_reaction: { value: "hold_and_wait", confidence: 0.6, rationale: "Moderate risk." },
  sustainability_preference: { value: "nice_to_have", confidence: 0.4, rationale: "No strong signal." },
  engagement_style: {
    value: "collaborative_discuss_key_decisions",
    confidence: 0.6,
    rationale: "Balanced engagement.",
  },
};

const validRequest = {
  method: "POST",
  headers: {
    authorization: "Bearer profile-token",
  },
  body: {
    input: {
      name: "Jhumma Singh",
      email: "jhumma@example.com",
      age: 31,
      phone_country_code: "+1",
      phone_number: "5550100",
      organisation: "Hushh",
    },
    context: {
      country: "US",
      region: "NA",
      currency: "USD",
      email_type: "personal",
      life_stage: "young_professional",
      financial_context: {
        nws_score: 82,
        nws_tier: "Elite",
      },
    },
  },
};

const importHandler = async () => {
  const module = await import("../api/generate-investor-profile.js");
  return module.default;
};

describe("generate investor profile GCP route", () => {
  beforeEach(() => {
    process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME = "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat";
    process.env.GCP_SERVER_ACTOR_UID = "test-server-actor";
    process.env.GEMINI_API_KEY = "gemini-key";
    delete process.env.GEMINI_INVESTOR_PROFILE_PROVIDER;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    delete process.env.OPENAI_API_KEY;
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    generateContent.mockResolvedValue({
      text: JSON.stringify({ investor_profile: validProfile }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;
    delete process.env.GCP_SERVER_ACTOR_UID;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_INVESTOR_PROFILE_MODEL;
    delete process.env.GEMINI_INVESTOR_PROFILE_PROVIDER;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    vi.clearAllMocks();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("generates the 12-field profile through server-side Gemini API key fallback", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, profile: validProfile });
    expect(createClient).toHaveBeenCalledWith(
      "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
      "test-server-actor",
    );
    expect(getUser).toHaveBeenCalledWith("profile-token");
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "gemini-key" });
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-flash",
        contents: expect.stringContaining('"financial_context"'),
        config: expect.objectContaining({
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 4096,
        }),
      }),
    );
  });

  it("generates through Vertex AI when configured for deployed Cloud Run", async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_INVESTOR_PROFILE_PROVIDER = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "hushh-tech-prod";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, profile: validProfile });
    expect(GoogleGenAI).toHaveBeenCalledWith({
      vertexai: true,
      project: "hushh-tech-prod",
      location: "us-central1",
      apiVersion: "v1",
    });
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-flash",
        contents: expect.stringContaining('"financial_context"'),
        config: expect.objectContaining({
          responseMimeType: "application/json",
        }),
      }),
    );
  });

  it("falls back to a Gemini API key when Vertex is temporarily unavailable", async () => {
    process.env.GEMINI_INVESTOR_PROFILE_PROVIDER = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "hushh-tech-prod";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
    generateContent
      .mockRejectedValueOnce(new Error("Vertex access temporarily denied"))
      .mockResolvedValueOnce({
        text: JSON.stringify({ investor_profile: validProfile }),
      });
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, profile: validProfile });
    expect(GoogleGenAI).toHaveBeenNthCalledWith(1, {
      vertexai: true,
      project: "hushh-tech-prod",
      location: "us-central1",
      apiVersion: "v1",
    });
    expect(GoogleGenAI).toHaveBeenNthCalledWith(2, { apiKey: "gemini-key" });
  });

  it("keeps the request contract validation on missing input or context", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler(
      {
        method: "POST",
        headers: validRequest.headers,
        body: {},
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: "Missing required fields: input and context" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("returns a clean configuration error when the Gemini key is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Investor profile AI is not configured on server");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("does not leak provider quota details to the browser", async () => {
    generateContent.mockRejectedValue(new Error("429 quota exhausted at platform.openai.com"));
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe(
      "Investor profile intelligence is temporarily unavailable. Please try again shortly.",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/openai|platform\.openai|quota/i);
  });

  it("keeps the profile browser flow off Supabase functions and OpenAI", () => {
    const files = [
      "api/generate-investor-profile.js",
      "src/services/investorProfile/apiClient.ts",
      "src/services/investorProfile/generateProfile.ts",
    ];
    const combined = files
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    const serverManifest = JSON.parse(
      readFileSync(join(process.cwd(), "package-server.json"), "utf8"),
    );

    expect(combined).toMatch(/GEMINI_API_KEY/);
    expect(serverManifest.dependencies).toHaveProperty("@google/genai");
    expect(combined).not.toMatch(/OPENAI_API_KEY|api\.openai\.com|gpt-/i);
    expect(combined).not.toMatch(/functions\/v1\/generate-investor-profile/);
    expect(combined).not.toMatch(/VITE_GEMINI_API_KEY/);
  });
});
