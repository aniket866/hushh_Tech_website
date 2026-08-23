/**
 * Hushh AI Authentication Utilities
 * Custom OAuth handlers that redirect back to Hushh AI instead of main project
 */
import config from '../../../resources/config/config';

/**
 * Google Sign-In for Hushh AI
 * Redirects to /hushh-ai after successful OAuth
 */
export async function hushhAIGoogleSignIn() {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      console.error('GcpBackend client is not initialized');
      return { error: 'GcpBackend client not initialized' };
    }

    // Set redirect to come back to Hushh AI
    const baseRedirectUrl =
      config.redirect_url || `${window.location.origin}/auth/callback`;
    const redirectTo = `${baseRedirectUrl}?redirect=${encodeURIComponent('/hushh-ai')}`;

    const { data, error } = await gcpBackend.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        scopes: 'email profile openid',
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });

    if (error) {
      console.error('Hushh AI Google sign-in failed:', error);
      return { error: error.message };
    }

    if (data?.url) {
      window.location.assign(data.url);
    }

    return { error: null };
  } catch (error) {
    console.error('Hushh AI Google Sign-In failed:', error);
    return { error: (error as Error).message };
  }
}

/**
 * Apple Sign-In for Hushh AI
 * Redirects to /hushh-ai after successful OAuth
 */
export async function hushhAIAppleSignIn() {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      console.error('GcpBackend client is not initialized');
      return { error: 'GcpBackend client not initialized' };
    }

    // Set redirect to come back to Hushh AI
    const baseRedirectUrl =
      config.redirect_url || `${window.location.origin}/auth/callback`;
    const redirectTo = `${baseRedirectUrl}?redirect=${encodeURIComponent('/hushh-ai')}`;
    console.info('[HushhAI][AppleSignIn] Starting Apple OAuth', { redirectTo });

    const { data, error } = await gcpBackend.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo,
        scopes: 'name email',
      },
    });

    if (error) {
      console.error('Hushh AI Apple sign-in failed:', error);
      return { error: error.message };
    }

    if (data?.url) {
      window.location.assign(data.url);
    }

    return { error: null };
  } catch (error) {
    console.error('Hushh AI Apple Sign-In failed:', error);
    return { error: (error as Error).message };
  }
}
