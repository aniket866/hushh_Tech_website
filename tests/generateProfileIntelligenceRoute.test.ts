import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const createClient = vi.fn(() => ({
  auth: { getUser },
}));
const fetchMock = vi.fn();

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

const validRequest = {
  method: "POST",
  headers: {
    authorization: "Bearer profile-token",
  },
  body: {
    input: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      zipCode: "10001",
      context: {
        legalName: "Ada Byron Lovelace",
        organisation: "Analytical Engines Lab",
        city: "New York",
        state: "New York",
        residenceCountry: "United States",
        phoneNumber: "should-not-forward",
      },
    },
  },
};

const importHandler = async () => {
  const module = await import("../api/generate-profile-intelligence.js");
  return module.default;
};

describe("generate profile intelligence route", () => {
  beforeEach(() => {
    process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME = "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat";
    process.env.GCP_SERVER_ACTOR_UID = "test-server-actor";
    process.env.PROFILE_INTELLIGENCE_API_BASE_URL = "https://profile-intelligence.example";
    process.env.PROFILE_INTELLIGENCE_TIMEOUT_MS = "1000";
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        summary: "Public sources show a technical founder profile with limited investment signals.",
        missingInformation: ["verified investment history", "current firm affiliation"],
        confidence: "medium",
        model: "gemini-3.1-pro-preview",
        sources: [
          {
            title: "Ada Example Profile",
            uri: "https://example.com/ada",
          },
          {
            title: "Duplicate Source",
            uri: "https://example.com/ada",
          },
          {
            title: "Unsafe Source",
            uri: "javascript:alert(1)",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;
    delete process.env.GCP_SERVER_ACTOR_UID;
    delete process.env.PROFILE_INTELLIGENCE_API_BASE_URL;
    delete process.env.PROFILE_INTELLIGENCE_TIMEOUT_MS;
    delete process.env.PROFILE_INTELLIGENCE_DISABLED;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("requires a Supabase bearer token", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler({ ...validRequest, headers: {} }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("Missing authorization header");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires name, email, and ZIP code before calling the upstream intelligence backend", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler(
      {
        ...validRequest,
        body: {
          input: {
            name: "Ada Lovelace",
            email: "ada@example.com",
            zipCode: "",
          },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Missing required fields: zipCode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid email before calling the upstream intelligence backend", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler(
      {
        ...validRequest,
        body: {
          input: {
            name: "Ada Lovelace",
            email: "not-an-email",
            zipCode: "10001",
          },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid email");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips profile intelligence without calling upstream when disabled", async () => {
    process.env.PROFILE_INTELLIGENCE_DISABLED = "true";
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: false,
      skipped: true,
      error: "Profile intelligence is currently paused.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes a valid OSINT response into the profileIntelligence shape", async () => {
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://profile-intelligence.example/v1/intelligence/osint-profile",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@example.com",
          zipCode: "10001",
          context:
            "Legal name: Ada Byron Lovelace; Organisation: Analytical Engines Lab; Residence country: United States; City: New York; State: New York",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].body).not.toContain("should-not-forward");
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(res.body.success).toBe(true);
    expect(res.body.intelligence).toMatchObject({
      status: "completed",
      headline: "Public sources show a technical founder profile with limited investment signals",
      summary: "Public sources show a technical founder profile with limited investment signals.",
      summaryBullets: ["Public sources show a technical founder profile with limited investment signals."],
      confidenceLabel: "Medium",
      model: "gemini-3.1-pro-preview",
      missingSignals: expect.arrayContaining(["verified investment history", "current firm affiliation"]),
      evidence: [
        {
          title: "Ada Example Profile",
          url: "https://example.com/ada",
          domain: "example.com",
          supports: "Professional profile",
        },
      ],
      sources: [
        {
          title: "Ada Example Profile",
          url: "https://example.com/ada",
          domain: "example.com",
        },
      ],
    });
    expect(res.body.shadow_profile).toMatchObject({
      confidence: expect.any(Number),
      profileIntelligence: res.body.intelligence,
    });
  });

  it("does not block upstream safety-validation wording in the returned summary", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        summary:
          "Generated summary failed safety validation, so detailed person-level assertions were withheld.",
        missingInformation: ["source-backed claims"],
        model: "gemini-3.1-pro-preview",
        sources: [],
      }),
    });
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.intelligence.summary).toContain("failed safety validation");
    expect(res.body.intelligence.missingInformation).toContain("source-backed claims");
  });

  it("returns a safe browser error when the upstream backend fails", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({
        detail: "internal provider stack: secret token exhausted",
      }),
    });
    const handler = await importHandler();
    const res = createResponse();

    await handler(validRequest, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe(
      "Profile intelligence is temporarily unavailable. Please try again shortly.",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/secret|token|provider/i);
  });
});
