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
export const checkNDAStatus = async (userId: string): Promise<NDAStatus> => {
  try {
    if (!config.gcpBackendClient) {
      console.error('GcpBackend client not initialized');
      return {
        hasSignedNda: false,
        signedAt: null,
        ndaVersion: null,
        signerName: null,
      };
    }
    
    const { data, error } = await config.gcpBackendClient
      .rpc('check_user_nda_status', { p_user_id: userId });
    
    if (error) {
      console.error('Error checking NDA status:', error);
      return {
        hasSignedNda: false,
        signedAt: null,
        ndaVersion: null,
        signerName: null,
      };
    }
    
    return data as NDAStatus;
  } catch (err) {
    console.error('Error in checkNDAStatus:', err);
    return {
      hasSignedNda: false,
      signedAt: null,
      ndaVersion: null,
      signerName: null,
    };
  }
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
): Promise<SignNDAResult> => {
  try {
    if (!config.gcpBackendClient) {
      console.error('GcpBackend client not initialized');
      return {
        success: false,
        error: 'GcpBackend client not initialized',
      };
    }

    // The full electronic-signature evidence (real IP via x-forwarded-for, the
    // device, and the signature ID) is captured + persisted server-side by the
    // nda-signed-notification edge function — the browser is never trusted for it.
    const { data, error } = await config.gcpBackendClient
      .rpc('sign_global_nda', {
        p_signer_name: signerName,
        p_nda_version: ndaVersion,
        p_pdf_url: pdfUrl || null,
        p_signer_ip: 'unknown',
        p_documents_acknowledged: documentsAcknowledged ?? [],
        p_consent_version: consentVersion ?? null,
      });
    
    if (error) {
      console.error('Error signing NDA:', error);
      return {
        success: false,
        error: error.message,
      };
    }
    
    return data as SignNDAResult;
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
    const filePath = `signed-ndas/${fileName}`;
    
    const { data, error } = await config.gcpBackendClient.storage
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
 * Fetch the current user's NDA signature row for their profile. RLS on
 * `nda_signatures` restricts this to the caller's own row, so it's safe to
 * query directly from the client. Returns null when the user hasn't signed yet.
 */
export const getNDARecord = async (userId: string): Promise<NDARecord | null> => {
  try {
    if (!config.gcpBackendClient) {
      console.error('GcpBackend client not initialized');
      return null;
    }

    const { data, error } = await config.gcpBackendClient
      .from('nda_signatures')
      .select('signer_name, nda_version, signed_at, pdf_url')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[NDA] getNDARecord error:', error.message);
      return null;
    }
    if (!data) return null;

    return {
      signerName: data.signer_name ?? null,
      ndaVersion: data.nda_version ?? null,
      signedAt: data.signed_at ?? null,
      pdfUrl: data.pdf_url ?? null,
    };
  } catch (err) {
    console.warn('[NDA] getNDARecord exception:', err);
    return null;
  }
};

export default {
  checkNDAStatus,
  signNDA,
  generateNDAPdf,
  sendNDANotification,
  uploadSignedNDA,
  getNDARecord,
};
