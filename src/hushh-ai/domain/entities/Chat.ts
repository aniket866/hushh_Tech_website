/**
 * Chat Entity
 * Pure business object with NO dependencies on React or GcpBackend
 */
export class Chat {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public title: string,
    public readonly createdAt: Date,
    public updatedAt: Date,
    public messageCount: number = 0
  ) {}

  updateTitle(newTitle: string): Chat {
    return new Chat(
      this.id,
      this.userId,
      newTitle,
      this.createdAt,
      new Date(),
      this.messageCount
    );
  }

  incrementMessageCount(): Chat {
    return new Chat(
      this.id,
      this.userId,
      this.title,
      this.createdAt,
      new Date(),
      this.messageCount + 1
    );
  }

  isOwnedBy(userId: string): boolean {
    return this.userId === userId;
  }
}
