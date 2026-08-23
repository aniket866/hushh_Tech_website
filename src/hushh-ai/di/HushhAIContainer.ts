/**
 * Hushh AI Dependency Injection Container
 * Wires together all layers of the application
 */
import { GcpBackendClient } from '@/services/gcpBackend/types';
import config from '../../resources/config/config';

// Data Sources
import {
  GcpBackendChatDataSource,
  GcpBackendMessageDataSource,
  GcpBackendUserDataSource,
  GcpBackendMediaDataSource,
  VertexAIDataSource,
} from '../data/datasources';
import { CalendarAPIDataSource } from '../data/datasources/CalendarAPIDataSource';

// Repository Implementations
import {
  ChatRepositoryImpl,
  MessageRepositoryImpl,
  UserRepositoryImpl,
  MediaRepositoryImpl,
  AIRepositoryImpl,
} from '../data/repositories';

// Use Cases
import {
  GetChatsUseCase,
  CreateChatUseCase,
  DeleteChatUseCase,
  GetMessagesUseCase,
  SendMessageUseCase,
  SaveAIResponseUseCase,
  GetCurrentUserUseCase,
  UploadMediaUseCase,
  HandleCalendarRequestUseCase,
} from '../domain/usecases';

export class HushhAIContainer {
  private static instance: HushhAIContainer;

  // GcpBackend client
  private gcpBackend: GcpBackendClient;

  // Data Sources
  private chatDataSource: GcpBackendChatDataSource;
  private messageDataSource: GcpBackendMessageDataSource;
  private userDataSource: GcpBackendUserDataSource;
  private mediaDataSource: GcpBackendMediaDataSource;
  private aiDataSource: VertexAIDataSource;
  private calendarDataSource: CalendarAPIDataSource;

  // Repositories
  private chatRepository: ChatRepositoryImpl;
  private messageRepository: MessageRepositoryImpl;
  private userRepository: UserRepositoryImpl;
  private mediaRepository: MediaRepositoryImpl;
  private aiRepository: AIRepositoryImpl;

  // Use Cases
  public getChatsUseCase: GetChatsUseCase;
  public createChatUseCase: CreateChatUseCase;
  public deleteChatUseCase: DeleteChatUseCase;
  public getMessagesUseCase: GetMessagesUseCase;
  public sendMessageUseCase: SendMessageUseCase;
  public saveAIResponseUseCase: SaveAIResponseUseCase;
  public getCurrentUserUseCase: GetCurrentUserUseCase;
  public uploadMediaUseCase: UploadMediaUseCase;
  public handleCalendarRequestUseCase: HandleCalendarRequestUseCase;

  private constructor() {
    // Initialize GcpBackend client
    this.gcpBackend = config.gcpBackendClient;

    // Initialize Data Sources
    this.chatDataSource = new GcpBackendChatDataSource(this.gcpBackend);
    this.messageDataSource = new GcpBackendMessageDataSource(this.gcpBackend);
    this.userDataSource = new GcpBackendUserDataSource(this.gcpBackend);
    this.mediaDataSource = new GcpBackendMediaDataSource(this.gcpBackend);
    this.aiDataSource = new VertexAIDataSource(
      config.GCP_API_BASE_URL,
      config.FIREBASE_API_KEY
    );
    this.calendarDataSource = new CalendarAPIDataSource();

    // Initialize Repositories
    this.chatRepository = new ChatRepositoryImpl(this.chatDataSource);
    this.messageRepository = new MessageRepositoryImpl(this.messageDataSource);
    this.userRepository = new UserRepositoryImpl(this.userDataSource);
    this.mediaRepository = new MediaRepositoryImpl(this.mediaDataSource);
    this.aiRepository = new AIRepositoryImpl(this.aiDataSource);

    // Initialize Use Cases
    this.getChatsUseCase = new GetChatsUseCase(this.chatRepository);
    this.createChatUseCase = new CreateChatUseCase(this.chatRepository);
    this.deleteChatUseCase = new DeleteChatUseCase(this.chatRepository);
    this.getMessagesUseCase = new GetMessagesUseCase(this.messageRepository);
    this.sendMessageUseCase = new SendMessageUseCase(
      this.messageRepository,
      this.aiRepository
    );
    this.saveAIResponseUseCase = new SaveAIResponseUseCase(this.messageRepository);
    this.getCurrentUserUseCase = new GetCurrentUserUseCase(this.userRepository);
    this.uploadMediaUseCase = new UploadMediaUseCase(this.mediaRepository);
    this.handleCalendarRequestUseCase = new HandleCalendarRequestUseCase(
      this.calendarDataSource
    );
  }

  public static getInstance(): HushhAIContainer {
    if (!HushhAIContainer.instance) {
      HushhAIContainer.instance = new HushhAIContainer();
    }
    return HushhAIContainer.instance;
  }

  // Helper method to check if user is authenticated
  public async isAuthenticated(): Promise<boolean> {
    return this.userRepository.isAuthenticated();
  }

  // Helper method to get media limits
  public async getMediaLimits(userId: string) {
    return this.mediaRepository.getLimits(userId);
  }
}
