/**
 * User Entity
 * Pure business object with NO dependencies on React or GcpBackend
 */
export class User {
  constructor(
    public readonly id: string,
    public readonly supabaseUserId: string,
    public readonly email: string,
    public displayName: string | null,
    public avatarUrl: string | null,
    public readonly createdAt: Date,
    public lastLoginAt: Date,
    public totalMessages: number = 0,
    public totalChats: number = 0,
    public isActive: boolean = true
  ) {}

  updateLastLogin(): User {
    return new User(
      this.id,
      this.supabaseUserId,
      this.email,
      this.displayName,
      this.avatarUrl,
      this.createdAt,
      new Date(),
      this.totalMessages,
      this.totalChats,
      this.isActive
    );
  }

  updateProfile(displayName: string | null, avatarUrl: string | null): User {
    return new User(
      this.id,
      this.supabaseUserId,
      this.email,
      displayName,
      avatarUrl,
      this.createdAt,
      this.lastLoginAt,
      this.totalMessages,
      this.totalChats,
      this.isActive
    );
  }

  incrementMessageCount(): User {
    return new User(
      this.id,
      this.supabaseUserId,
      this.email,
      this.displayName,
      this.avatarUrl,
      this.createdAt,
      this.lastLoginAt,
      this.totalMessages + 1,
      this.totalChats,
      this.isActive
    );
  }

  incrementChatCount(): User {
    return new User(
      this.id,
      this.supabaseUserId,
      this.email,
      this.displayName,
      this.avatarUrl,
      this.createdAt,
      this.lastLoginAt,
      this.totalMessages,
      this.totalChats + 1,
      this.isActive
    );
  }
}
