/**
 * Calendar Utility Functions
 * Helper functions for calendar intent detection and OAuth token retrieval
 */
import config from '../../../resources/config/config';
import { logger } from './logger';

/**
 * Calendar-related keywords for intent detection
 */
export const CALENDAR_KEYWORDS = [
  'schedule',
  'meeting',
  'calendar',
  'event',
  'remind',
  'book',
  'appointment',
  'tomorrow',
  'next week',
  'today',
  'call',
  'meet',
  'discussion',
  'sync',
  'cancel',
  'reschedule',
  'available',
  'free time',
];

/**
 * Check if a message contains calendar-related intent
 */
export function isCalendarIntent(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return CALENDAR_KEYWORDS.some((keyword) => lowerMessage.includes(keyword));
}

/**
 * Get the user's Google OAuth token from GcpBackend session
 */
export async function getUserGoogleToken(): Promise<string | null> {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      logger.error('GcpBackend client not initialized');
      return null;
    }

    const {
      data: { session },
      error,
    } = await gcpBackend.auth.getSession();

    if (error) {
      logger.error('Failed to get session', error);
      return null;
    }

    if (!session) {
      logger.warn('No active session found');
      return null;
    }

    // provider_token contains the Google OAuth token
    const googleToken = session.provider_token;

    if (!googleToken) {
      logger.warn('No Google OAuth token found in session. User may need to re-authenticate with calendar scopes.');
      return null;
    }

    return googleToken;
  } catch (err) {
    logger.error('Error getting Google OAuth token', err as Error);
    return null;
  }
}
