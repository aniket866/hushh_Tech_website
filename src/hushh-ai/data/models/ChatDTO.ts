/**
 * Chat Data Transfer Object
 * Matches GcpBackend database schema
 */
export interface ChatDTO {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}
