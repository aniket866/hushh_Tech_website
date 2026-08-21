import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { normalizeOAuthRedirectUrl } from "../../auth/authHost";
import { isHushhResearchAuthMode } from "../../services/hushhResearch/firebaseAuth";
import { getOAuthRedirectUrl } from "../../utils/platform";

export interface ClientEnvConfig {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_REDIRECT_URL?: string;
  VITE_PLAID_REDIRECT_URI?: string;
  VITE_NDA_GENERATION_URL?: string;
}

interface Config {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  redirect_url: string;
  supabaseClient?: SupabaseClient;
}

function readClientEnv(value: string | undefined, name: string, fallback = ""): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  console.error(`[Config] Missing required client environment variable: ${name}`);
  return fallback;
}

export function buildClientConfig(
  env: ClientEnvConfig,
  fallbackRedirectUrl = getOAuthRedirectUrl()
): Omit<Config, "supabaseClient"> {
  return {
    SUPABASE_URL: readClientEnv(env.VITE_SUPABASE_URL, "VITE_SUPABASE_URL"),
    SUPABASE_ANON_KEY: readClientEnv(
      env.VITE_SUPABASE_ANON_KEY,
      "VITE_SUPABASE_ANON_KEY"
    ),
    redirect_url: normalizeOAuthRedirectUrl(
      env.VITE_SUPABASE_REDIRECT_URL,
      fallbackRedirectUrl
    ),
  };
}

export function createSupabaseClient(
  baseConfig: Pick<Config, "SUPABASE_URL" | "SUPABASE_ANON_KEY">
): SupabaseClient | undefined {
  if (!baseConfig.SUPABASE_URL || !baseConfig.SUPABASE_ANON_KEY) {
    return undefined;
  }

  const supabase = createClient(
    baseConfig.SUPABASE_URL,
    baseConfig.SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    }
  );
  return supabase;
}

export function shouldSuppressLegacySupabaseBootstrap(): boolean {
  return isHushhResearchAuthMode();
}

const config: Config = buildClientConfig(import.meta.env);
if (!shouldSuppressLegacySupabaseBootstrap()) {
  config.supabaseClient = createSupabaseClient(config);
}

export default config;
