import axios from "axios";
import config from "../../resources/config/config";
import {
  getNdaGenerationUrl,
  getGcpBackendBaseUrl,
  getGcpBackendRpcUrl,
} from "../runtime/mainWeb";

export type AccessStatus = string;
const APPROVED_STATUS = "Approved";
export const NDA_REQUIRED_STATUS = "Pending: Waiting for NDA Process";

export interface NdaMetadataResponse {
  metadata?: Record<string, unknown>;
  message?: string;
  status?: string;
}

interface RequestFileAccessParams {
  investorType: string;
  metadata: string;
}

function getAuthenticatedHeaders(accessToken: string) {
  return {
    apikey: config.FIREBASE_API_KEY,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function postRpc<T>(
  rpcName: string,
  accessToken: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const response = await axios.post<T>(getGcpBackendRpcUrl(rpcName), body, {
    headers: getAuthenticatedHeaders(accessToken),
  });
  return response.data;
}

export async function checkAccessStatus(accessToken: string): Promise<AccessStatus> {
  const response = await axios.get<Array<{ signed_at: string | null }>>(
    `${getGcpBackendBaseUrl()}/rest/v1/nda_signatures`,
    {
      headers: getAuthenticatedHeaders(accessToken),
      params: {
        select: "signed_at",
        signed_at: "not.is.null",
        limit: "1",
      },
    }
  );

  return response.data?.some((row) => Boolean(row.signed_at))
    ? APPROVED_STATUS
    : NDA_REQUIRED_STATUS;
}

export function getNdaMetadata(accessToken: string) {
  return postRpc<NdaMetadataResponse>("get_nda_metadata", accessToken);
}

export function acceptNda(accessToken: string) {
  return postRpc<AccessStatus>("accept_nda_v2", accessToken);
}

export function requestFileAccess(
  accessToken: string,
  params: RequestFileAccessParams
) {
  return postRpc<AccessStatus>("request_file_access", accessToken, {
    investor_type: params.investorType,
    metadata: params.metadata,
  });
}

export async function generateNdaPdfBlob(
  accessToken: string,
  metadata: Record<string, unknown>
): Promise<Blob> {
  const response = await axios.post(getNdaGenerationUrl(), { metadata }, {
    headers: {
      "Content-Type": "application/json",
      "jwt-token": accessToken,
    },
    responseType: "blob",
  });

  return response.data as Blob;
}
