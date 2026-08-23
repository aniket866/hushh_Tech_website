import resources from "../../resources/resources";

export default async function signOut() {
  if (resources.config.gcpBackendClient) {
    await resources.config.gcpBackendClient.auth.signOut();
  }
}
