/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Firebase Identity Platform + same-origin GCP APIs
  readonly VITE_GCP_API_BASE_URL?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_GCP_AUTH_REDIRECT_URL?: string;
  readonly VITE_PLAID_REDIRECT_URI?: string;
  readonly VITE_PLAID_ENV?: string;
  readonly VITE_PLAID_LINK_MODE?: string;
  readonly VITE_PLAID_DISABLE_LOCAL_SANDBOX_DIRECT?: string;
  readonly VITE_ALLOW_LOCAL_PLAID_LINK?: string;
  readonly VITE_NDA_GENERATION_URL?: string;
  readonly VITE_GUEST_MODE_ACCESS_TOKEN?: string;
  readonly VITE_MARKET_GCS_PUBLIC_BASE_URL?: string;
  readonly VITE_MARKET_GCS_SIGNED_URL_PATH?: string;

  // Gemini API Keys (with fallback support)
  readonly VITE_GEMINI_API_KEY: string;
  readonly VITE_GEMINI_API_KEY_FALLBACK_1?: string;
  readonly VITE_GEMINI_API_KEY_FALLBACK_2?: string;
  readonly VITE_GEMINI_API_KEY_FALLBACK_3?: string;

  // OpenAI
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_ALLOW_INSECURE_BROWSER_LLM?: string;

  // n8n Webhook
  readonly VITE_N8N_WEBHOOK_URL?: string;

  // Voice Agent
  readonly VITE_VOICE_AGENT_URL?: string;
  // Finnhub Stock API
  readonly VITE_FINNHUB_API_KEY?: string;

  // KYC
  readonly VITE_KYC_ENV?: string;
  readonly VITE_KYC_API_BASE?: string;
  readonly VITE_KYC_DEMO_MODE?: string;
  readonly VITE_KYC_TEST_BANK_IDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
