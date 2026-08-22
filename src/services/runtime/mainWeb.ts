import config from "../../resources/config/config";

const DEFAULT_NDA_GENERATION_BASE_URL =
  "https://hushhtech-nda-generation-53407187172.us-central1.run.app";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function isUsableConfiguredUrl(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.includes("YOUR_PROJECT_REF");
}

export function getGcpBackendBaseUrl(): string {
  return trimTrailingSlash(config.GCP_API_BASE_URL);
}

export function getGcpBackendRpcUrl(rpcName: string): string {
  return `${getGcpBackendBaseUrl()}/rest/v1/rpc/${rpcName}`;
}

export function getGcpBackendStoragePublicUrl(
  bucket: string,
  objectPath = ""
): string {
  const baseUrl = `${getGcpBackendBaseUrl()}/storage/v1/object/public/${trimLeadingSlash(
    bucket
  )}`;

  if (!objectPath) {
    return baseUrl;
  }

  return `${baseUrl}/${trimLeadingSlash(objectPath)}`;
}

export function getNdaGenerationBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_NDA_GENERATION_URL?.trim();
  return trimTrailingSlash(
    isUsableConfiguredUrl(configuredBaseUrl)
      ? configuredBaseUrl
      : DEFAULT_NDA_GENERATION_BASE_URL
  );
}

export function getNdaGenerationUrl(): string {
  return `${getNdaGenerationBaseUrl()}/generate-nda`;
}
