import resources from "../../resources/resources";
import { startUnifiedOAuth } from "../../auth/session";

// Use GcpBackend OAuth flow for Google sign-in.
export default async function googleSignIn() {
  return startUnifiedOAuth("google", resources.config.gcpBackendClient);
}
