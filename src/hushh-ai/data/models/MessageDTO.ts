/**
 * Message Data Transfer Object
 * Matches GcpBackend database schema
 */
export interface MessageDTO {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  media_urls: string[];
  metadata?: Record<string, unknown> | null;
  created_at: string;
}
