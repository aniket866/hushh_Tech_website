import { createMetadataIdentityTokenProvider } from "./shared/gcpServiceIdentity.js";
import { createPublicStockQuotesGateway } from "./shared/publicStockQuotesGateway.js";

export function createStockQuotesHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestId,
  getServiceIdentityToken,
} = {}) {
  return createPublicStockQuotesGateway({
    env,
    fetchImpl,
    now,
    requestId,
    getServiceIdentityToken:
      getServiceIdentityToken ??
      createMetadataIdentityTokenProvider({ fetchImpl, now }),
  });
}

export default createStockQuotesHandler();
