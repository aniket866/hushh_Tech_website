import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("crypto", () => ({
  createSign: () => ({
    update: vi.fn(),
    end: vi.fn(),
    sign: () => Buffer.from("signature"),
  }),
}));

const walletobjectsFactory = vi.fn();
const jwtFactory = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      JWT: jwtFactory,
    },
    walletobjects: walletobjectsFactory,
  },
}));

const createResponse = () => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown;

  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  };
};

describe("google wallet local route", () => {
  afterEach(() => {
    delete process.env.GOOGLE_WALLET_ISSUER_ID;
    delete process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_WALLET_PRIVATE_KEY;
    delete process.env.GOOGLE_WALLET_CLASS_SUFFIX;
    vi.clearAllMocks();
  });

  it("returns a native Google Wallet saveUrl when local issuer config is present", async () => {
    process.env.GOOGLE_WALLET_ISSUER_ID = "issuer-123";
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL =
      "wallet-service@hushh-tech-prod.iam.gserviceaccount.com";
    process.env.GOOGLE_WALLET_PRIVATE_KEY = "test-private-key";
    process.env.GOOGLE_WALLET_CLASS_SUFFIX = "hushh_gold_investor_v1";

    const genericclass = {
      get: vi.fn().mockRejectedValue({ code: 404 }),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const genericobject = {
      get: vi.fn().mockRejectedValue({ code: 404 }),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };

    walletobjectsFactory.mockReturnValue({
      genericclass,
      genericobject,
    });
    // `api/google-wallet-pass.js` does `new google.auth.JWT(...)`, and an arrow function is not
    // a constructor — vitest 4 calls the implementation with `new` instead of tolerating it.
    jwtFactory.mockImplementation(function createJwt() {
      return {};
    });

    const { default: googleWalletPassHandler } = await import(
      "../api/google-wallet-pass.js"
    );

    const req = {
      method: "POST",
      body: {
        passType: "storeCard",
        description: "Hushh Gold Investor Pass",
        organizationName: "Hushh Technologies",
        headerFields: [
          { key: "status", value: "Gold Member" },
          { key: "org", value: "Hushh" },
        ],
        primaryFields: [{ key: "investor", value: "Test User" }],
        secondaryFields: [{ key: "class", value: "Investor - Class B" }],
        auxiliaryFields: [
          { key: "email", value: "test@example.com" },
          { key: "memberId", value: "test-user" },
        ],
        barcode: { message: "https://hushhtech.com/investor/test-user" },
      },
    };
    const res = createResponse();

    await googleWalletPassHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      provider: "local",
    });
    expect(String(res.body.saveUrl)).toMatch(
      /^https:\/\/pay\.google\.com\/gp\/v\/save\//
    );
    expect(genericclass.insert).toHaveBeenCalledTimes(1);
    expect(genericobject.insert).toHaveBeenCalledTimes(1);
  });
});
