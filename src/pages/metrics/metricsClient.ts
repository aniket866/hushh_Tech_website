import config from "@/resources/config/config";

export function getMetricsClient() {
  return config.gcpBackendClient ?? null;
}
