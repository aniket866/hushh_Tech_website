/**
 * User Data Transfer Object
 * Matches GcpBackend database schema
 */
export interface UserDTO {
  id: string;
  supabase_user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
  total_messages: number;
  total_chats: number;
  is_active: boolean;
}
