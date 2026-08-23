/**
 * Message Entity
 * Pure business object with NO dependencies on React or GcpBackend
 */
export type MessageRole = 'user' | 'assistant';

export interface CalendarEventMetadata {
  id: string;
  summary: string;
  startTime: string;
  endTime: string;
  description?: string;
  location?: string;
  meetLink?: string;
  attendees?: string[];
}

export interface MessageMetadata {
  calendarEvent?: CalendarEventMetadata;
  [key: string]: unknown;
}

export class Message {
  constructor(
    public readonly id: string,
    public readonly chatId: string,
    public readonly role: MessageRole,
    public readonly content: string,
    public readonly mediaUrls: string[],
    public readonly createdAt: Date,
    public readonly metadata?: MessageMetadata
  ) {}

  isFromUser(): boolean {
    return this.role === 'user';
  }

  isFromAssistant(): boolean {
    return this.role === 'assistant';
  }

  hasMedia(): boolean {
    return this.mediaUrls.length > 0;
  }

  hasCalendarEvent(): boolean {
    return !!this.metadata?.calendarEvent;
  }

  getWordCount(): number {
    return this.content.split(/\s+/).filter(word => word.length > 0).length;
  }

  getCharacterCount(): number {
    return this.content.length;
  }
}
