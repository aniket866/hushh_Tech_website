/**
 * NDA Service
 * Handles all NDA-related API calls for the global NDA gate feature
 */

import config from '../../resources/config/config';
import { getNdaGenerationUrl } from '../runtime/mainWeb';

// GcpBackend function URL for NDA notification
const NDA_NOTIFICATION_FUNCTION_URL = `${config.GCP_API_BASE_URL}/functions/v1/nda-signed-notification`;

export interface NDAStatus {
  hasSignedNda: boolean;
  signedAt: string | null;
  ndaVersion: string | null;
  signerName: string | null;
}

export interface SignNDAResult {
  success: boolean;
  signedAt?: string;
  signerName?: string;
  ndaVersion?: string;
  error?: string;
  /** First-time sign or a genuine version change → notification emails fire. */
  shouldNotify?: boolean;
  wasInserted?: boolean;
  versionChanged?: boolean;
}

/**
 * Check if the current user has signed the NDA
 */
async function ndaOperation<T>(operation: 'status' | 'record' | 'sign', signing?: Record<string, unknown>, accessToken?: string): Promise<T> {
  let token = accessToken;
  if (token === undefined) {
    if (!config.gcpBackendClient) throw new Error('Authentication is unavailable. Please sign in again.');
    const { data, error } = await config.gcpBackendClient.auth.getSession();
    if (error) throw new Error('Please sign in again before reviewing the NDA.');
    token = data?.session?.access_token;
  }
  if (!token?.trim()) throw new Error('Please sign in again before reviewing the NDA.');
  const response = await fetch('/api/gcp/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: 'nda', operation, ...(signing ? { signing } : {}) }),
  });
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result?.error?.message || 'NDA service unavailable. Please retry.');
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid NDA response. Please retry.');
  return result.data as T;
}

// The parameter is retained for existing callers only. Ownership is always
// resolved by the server from the verified Firebase token, never this value.
export const checkNDAStatus = async (userId: string): Promise<NDAStatus> => {
  void userId; // Compatibility only; never sent as a principal selector.
  return checkNDAStatusWithToken();
};

// Protected-content callers already hold the Firebase session token. Reuse the
// same operation and server identity boundary, not the retired REST table API.
export const checkNDAStatusWithToken = async (accessToken?: string): Promise<NDAStatus> => {
  const status = await ndaOperation<NDAStatus>('status', undefined, accessToken);
  if (!status || typeof status.hasSignedNda !== 'boolean' ||
      ![status.signedAt, status.ndaVersion, status.signerName].every((value) => value === null || typeof value === 'string') ||
      (status.hasSignedNda && (typeof status.signedAt !== 'string' || !Number.isFinite(Date.parse(status.signedAt))))) {
    throw new Error('Invalid NDA status response. Please retry.');
  }
  return status;
};

/**
 * Sign the global NDA
 */
export const signNDA = async (
  signerName: string,
  ndaVersion: string = 'v1.0',
  pdfUrl?: string,
  documentsAcknowledged?: string[],
  consentVersion?: string,
  consentAccepted: boolean = false,
): Promise<SignNDAResult> => {
  try {
    return await ndaOperation<SignNDAResult>('sign', {
      signerName, ndaVersion, pdfUrl: pdfUrl || null,
      documentsAcknowledged: documentsAcknowledged ?? [],
      consentVersion: consentVersion ?? null, consentAccepted,
    });
  } catch (err) {
    console.error('Error in signNDA:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
};

/**
 * Generate personalized NDA PDF using Cloud Run service
 */
export const generateNDAPdf = async (
  metadata: Record<string, unknown>,
  accessToken: string
): Promise<{ success: boolean; pdfUrl?: string; blob?: Blob; error?: string }> => {
  try {
    const response = await fetch(
      getNdaGenerationUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'jwt-token': accessToken,
        },
        body: JSON.stringify({ metadata }),
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Failed to generate PDF: ${errorText}`,
      };
    }
    
    const blob = await response.blob();
    const pdfUrl = URL.createObjectURL(blob);
    
    return {
      success: true,
      pdfUrl,
      blob,
    };
  } catch (err) {
    console.error('Error generating NDA PDF:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
};

/**
 * Send NDA signed notification to manish@hushh.ai and ankit@hushh.ai
 */
export const sendNDANotification = async (
  signerName: string,
  signedAt: string,
  ndaVersion: string,
  pdfUrl?: string,
  pdfBlob?: Blob,
  documentsAcknowledged?: string[],
  accessToken?: string,
  signerIp?: string,
  evidence?: {
    userAgent?: string;
    signatureId?: string;
    signedAtLocal?: string;
    consentVersion?: string;
  },
): Promise<{ success: boolean; error?: string }> => {
  try {
    // Identity (signerEmail / userId) is intentionally NOT sent — the edge
    // function derives it from the caller's JWT. The IP is captured server-side
    // (x-forwarded-for); the client passes only the device + signature evidence.
    const payload: Record<string, unknown> = {
      signerName,
      signedAt,
      ndaVersion,
      signerIp: signerIp || 'Unknown',
      ...(evidence?.userAgent ? { userAgent: evidence.userAgent } : {}),
      ...(evidence?.signatureId ? { signatureId: evidence.signatureId } : {}),
      ...(evidence?.signedAtLocal ? { signedAtLocal: evidence.signedAtLocal } : {}),
      ...(evidence?.consentVersion ? { consentVersion: evidence.consentVersion } : {}),
    };

    // Include acknowledged fund documents list
    if (documentsAcknowledged && documentsAcknowledged.length > 0) {
      payload.documentsAcknowledged = documentsAcknowledged;
    }

    // Include PDF URL if available
    if (pdfUrl) {
      payload.pdfUrl = pdfUrl;
    }

    // Convert PDF blob to base64 if provided for attachment
    if (pdfBlob) {
      try {
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );
        payload.pdfBase64 = base64;
      } catch (blobErr) {
        console.warn('Could not convert PDF blob to base64:', blobErr);
      }
    }

    // Authenticate as the signer — the edge function now requires a real user
    // JWT and derives identity from it, so the endpoint can't be abused.
    let bearer = accessToken;
    if (!bearer) {
      const { data: sessionData } = await config.gcpBackendClient!.auth.getSession();
      bearer = sessionData?.session?.access_token ?? undefined;
    }
    if (!bearer) {
      return { success: false, error: 'Not authenticated — cannot send NDA notification' };
    }

    // Call the GcpBackend Edge Function
    const response = await fetch(NDA_NOTIFICATION_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearer}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('NDA notification failed:', errorText);
      return {
        success: false,
        error: `Failed to send notification: ${errorText}`,
      };
    }

    const result = await response.json();
    console.log('NDA notification sent successfully:', result);

    return { success: true };
  } catch (err) {
    console.error('Error sending NDA notification:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
};

/**
 * Upload signed NDA PDF to GcpBackend Storage
 */
export const uploadSignedNDA = async (
  userId: string,
  pdfBlob: Blob
): Promise<{ success: boolean; url?: string; error?: string }> => {
  try {
    if (!config.gcpBackendClient) {
      console.error('GcpBackend client not initialized');
      return {
        success: false,
        error: 'GcpBackend client not initialized',
      };
    }
    
    const fileName = `nda_${userId}_${Date.now()}.pdf`;
    const filePath = `${userId}/signed-ndas/${fileName}`;
    
    const { error } = await config.gcpBackendClient.storage
      .from('assets')
      .upload(filePath, pdfBlob, {
        contentType: 'application/pdf',
        upsert: false,
      });
    
    if (error) {
      console.error('Error uploading NDA PDF:', error);
      return {
        success: false,
        error: error.message,
      };
    }
    
    // Get public URL
    const { data: urlData } = config.gcpBackendClient.storage
      .from('assets')
      .getPublicUrl(filePath);
    
    return {
      success: true,
      url: urlData.publicUrl,
    };
  } catch (err) {
    console.error('Error in uploadSignedNDA:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
};

export interface NDARecord {
  signerName: string | null;
  ndaVersion: string | null;
  signedAt: string | null;
  pdfUrl: string | null;
}

/**
 * Fetch through the same verified identity boundary as status/signing.
 * Only a successful unsigned response is null; failures are not unsigned.
 */
export const getNDARecord = async (userId: string): Promise<NDARecord | null> => {
  void userId; // Compatibility only; the backend derives ownership.
  return ndaOperation<NDARecord | null>('record');
};

export default {
  checkNDAStatus,
  signNDA,
  generateNDAPdf,
  sendNDANotification,
  uploadSignedNDA,
  getNDARecord,
};
