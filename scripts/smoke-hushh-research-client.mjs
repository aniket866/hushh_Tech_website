const DEFAULT_TIMEOUT_MS = 15_000;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}
async function readJson(response, label) {
  const payload = await response.json().catch(() => null);
  return requireObject(payload, label);
}

function assertNoStore(response, label) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!cacheControl.toLowerCase().includes("no-store")) {
    throw new Error(`${label} must set Cache-Control: no-store.`);
  }
  return cacheControl;
}

export async function verifyHushhResearchClient(
  baseUrl,
  {
    expectedEnabled = false,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("Smoke target must use HTTPS outside localhost.");
  }

  const configUrl = new URL("/api/hushh-research/config", base);
  const configResponse = await fetchImpl(configUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (configResponse.status !== 200) {
    throw new Error(`Research client config returned ${configResponse.status}.`);
  }
  const configCacheControl = assertNoStore(configResponse, "Research client config");
  const config = await readJson(configResponse, "Research client config");
  if (config.enabled !== expectedEnabled) {
    throw new Error(
      `Research client enabled=${String(config.enabled)}; expected ${String(expectedEnabled)}.`
    );
  }

  if (!expectedEnabled) {
    if (JSON.stringify(config) !== '{"enabled":false}') {
      throw new Error("Disabled Research client config must not expose runtime details.");
    }
    const startResponse = await fetchImpl(new URL("/api/hushh-research/launch/start", base), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const startCacheControl = assertNoStore(startResponse, "Disabled launch route");
    const start = await readJson(startResponse, "Disabled launch route");
    if (startResponse.status !== 404 || start?.detail?.code !== "FEATURE_DISABLED") {
      throw new Error("Disabled launch route must fail with typed FEATURE_DISABLED.");
    }
    return {
      target: base.origin,
      enabled: false,
      config_status: configResponse.status,
      config_cache_control: configCacheControl,
      launch_status: startResponse.status,
      launch_state: start.detail.code,
      launch_cache_control: startCacheControl,
    };
  }

  const firebase = requireObject(config.firebase, "Firebase config");
  const launch = requireObject(config.launch, "Launch config");
  if (
    firebase.projectId !== "hushh-pda-uat" ||
    typeof firebase.apiKey !== "string" ||
    !firebase.apiKey ||
    typeof firebase.appId !== "string" ||
    !firebase.appId ||
    launch.audience !== "hushh-tech-uat" ||
    launch.redirectUri !== "https://uat.hushhtech.com/auth/hushh-research/callback"
  ) {
    throw new Error("Enabled Research client config does not match the UAT authority contract.");
  }
  return {
    target: base.origin,
    enabled: true,
    config_status: configResponse.status,
    config_cache_control: configCacheControl,
    firebase_project_id: firebase.projectId,
    audience: launch.audience,
    redirect_uri: launch.redirectUri,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("Usage: node scripts/smoke-hushh-research-client.mjs <base-url>");
    process.exit(2);
  }
  const expectedEnabled = process.env.EXPECTED_HUSHH_RESEARCH_CLIENT_ENABLED === "true";
  try {
    const result = await verifyHushhResearchClient(baseUrl, { expectedEnabled });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
