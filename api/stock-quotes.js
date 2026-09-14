import { createMetadataIdentityTokenProvider } from "./shared/gcpServiceIdentity.js";
import { createPublicStockQuotesGateway } from "./shared/publicStockQuotesGateway.js";
import {
  createPreferredQuoteProvider,
  createResearchQuoteProvider,
} from "./shared/researchQuotes.js";
import { createYahooQuoteProvider } from "./shared/yahooQuotes.js";

/**
 * hushh-research's shared cache first, this project's Yahoo client second.
 *
 * The shared service is the source of truth: it keeps the L1/L2 cache and the market-aware cadence
 * (120s while the US session is scheduled open, 1800s when closed) that this project would
 * otherwise be maintaining a second copy of, and its L2 is a Postgres table both Cloud Run
 * services read, so a warm quote is warm for both.
 *
 * The local client stays as the fallback because this is now a cross-service call, and a marquee
 * that blanks while another service redeploys is a worse trade than one spare provider. It also
 * decouples the rollout: until /api/market/quotes exists over there, every call falls through and
 * this site behaves exactly as it does today.
 */
const defaultQuoteProvider = ({ env, fetchImpl, now }) => {
  const fallback = createYahooQuoteProvider({ fetchImpl, now });
  const baseUrl = String(env.HUSHH_RESEARCH_API_BASE_URL ?? "").trim();
  if (!baseUrl) return fallback;

  return createPreferredQuoteProvider({
    preferred: createResearchQuoteProvider({ baseUrl, fetchImpl, now }),
    fallback,
    onFallback: (error) => {
      // Name the rung, never the upstream's message — it can carry a URL and this is a public path.
      console.warn(`stock-quotes: shared cache unavailable (${error?.name || "error"}); using Yahoo`);
    },
  });
};

export function createStockQuotesHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestId,
  getServiceIdentityToken,
  quoteProvider = defaultQuoteProvider({ env, fetchImpl, now }),
} = {}) {
  return createPublicStockQuotesGateway({
    env,
    fetchImpl,
    now,
    requestId,
    quoteProvider,
    getServiceIdentityToken:
      getServiceIdentityToken ??
      createMetadataIdentityTokenProvider({ fetchImpl, now }),
  });
}

export default createStockQuotesHandler();
