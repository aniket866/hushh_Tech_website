/**
 * Hushh AI - Main Chat Page
 * Claude-style UI with cream/white theme
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Flex, Text, Input, IconButton, VStack, HStack, Avatar, Spinner, useToast, useDisclosure, Menu, MenuButton, MenuList, MenuItem, Divider, Skeleton, Tooltip } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { THEME, BRANDING, LIMITS } from '../core/constants';
import type { HushhChat, HushhMessage, MediaLimits, ChatState, MessageMetadata } from '../core/types';
import * as service from '../services/hushhAIService';
import config from '../../resources/config/config';
import { trackProductUsage, PRODUCTS } from '../../services/productUsage/trackProductUsage';
import DeleteAccountModal from '../../components/DeleteAccountModal';

const MotionBox = motion(Box);

// ============================================
// Storage Keys for Caching
// ============================================
const STORAGE_KEYS = {
  AUTH_CACHED: 'hushh_ai_auth_cached',
  CURRENT_CHAT_ID: 'hushh_ai_current_chat_id',
  HAS_VISITED: 'hushh_ai_has_visited',
};

// Helper to check if already authenticated (fast path)
const getIsCachedAuth = () => sessionStorage.getItem(STORAGE_KEYS.AUTH_CACHED) === 'true';
const setIsCachedAuth = (value: boolean) => {
  if (value) {
    sessionStorage.setItem(STORAGE_KEYS.AUTH_CACHED, 'true');
  } else {
    sessionStorage.removeItem(STORAGE_KEYS.AUTH_CACHED);
  }
};

// Helper to persist current chat ID
const getPersistedChatId = () => localStorage.getItem(STORAGE_KEYS.CURRENT_CHAT_ID);
const setPersistedChatId = (chatId: string | null) => {
  if (chatId) {
    localStorage.setItem(STORAGE_KEYS.CURRENT_CHAT_ID, chatId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_CHAT_ID);
  }
};

// Check if this is the first visit (for loading screen)
const isFirstVisit = () => !sessionStorage.getItem(STORAGE_KEYS.HAS_VISITED);
const markAsVisited = () => sessionStorage.setItem(STORAGE_KEYS.HAS_VISITED, 'true');

// ============================================
// Main Component
// ============================================

export default function HushhAIPage() {
  const navigate = useNavigate();
  const toast = useToast();

  // State - Smart loading: only show on first visit, not cached auth
  const [isAuthenticated, setIsAuthenticated] = useState(getIsCachedAuth());
  const [isLoading, setIsLoading] = useState(!getIsCachedAuth() && isFirstVisit());
  const [isDataLoading, setIsDataLoading] = useState(true); // Track background data loading for shimmer
  const [userId, setUserId] = useState<string | null>(null);
  const [chats, setChats] = useState<HushhChat[]>([]);
  const [currentChat, setCurrentChat] = useState<HushhChat | null>(null);
  const [messages, setMessages] = useState<HushhMessage[]>([]);
  const [mediaLimits, setMediaLimits] = useState<MediaLimits | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatState, setChatState] = useState<ChatState>({
    isTyping: false,
    isSending: false,
    isStreaming: false,
    streamingContent: '',
    error: null,
  });
  const [inputValue, setInputValue] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [userProfile, setUserProfile] = useState<{ email: string; displayName: string | null; avatarUrl: string | null } | null | undefined>(undefined);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Calendar sidebar state

  // Delete account modal
  const { isOpen: isDeleteModalOpen, onOpen: onOpenDeleteModalOriginal, onClose: onCloseDeleteModal } = useDisclosure();

  // Wrap delete modal open with safety check
  const onOpenDeleteModal = () => {
    if (chatState.isStreaming || chatState.isSending) {
      toast({
        title: 'Please wait',
        description: 'Cannot delete account during active AI response',
        status: 'warning',
        duration: 3000,
      });
      return;
    }
    onOpenDeleteModalOriginal();
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ============================================
  // Effects
  // ============================================

  // Check auth on mount - with caching for fast navigation
  useEffect(() => {
    const checkAuth = async () => {
      // Fast path: if we have cached auth, skip loading and verify in background
      const hasCachedAuth = getIsCachedAuth();

      if (hasCachedAuth) {
        // Already authenticated from cache, load data in background
        setIsAuthenticated(true);
        setIsLoading(false);
        markAsVisited();

        // Load data and verify auth in background
        loadInitialData().catch(console.error);

        // Verify auth is still valid (non-blocking)
        service.isAuthenticated().then((stillValid) => {
          if (!stillValid) {
            // Session expired, clear cache and redirect
            setIsCachedAuth(false);
            setPersistedChatId(null);
            navigate('/hushh-ai/login');
          }
        });
        return;
      }

      // Slow path: first visit, need to authenticate
      const authenticated = await service.isAuthenticated();
      if (!authenticated) {
        navigate('/hushh-ai/login');
        return;
      }

      // Cache successful auth for future navigations
      setIsCachedAuth(true);
      markAsVisited();

      setIsAuthenticated(true);
      await loadInitialData();
      setIsLoading(false);
    };

    checkAuth();

    // Subscribe to auth changes
    const unsubscribe = service.onAuthChange((loggedIn) => {
      if (!loggedIn) {
        // Clear cache on logout
        setIsCachedAuth(false);
        setPersistedChatId(null);
        navigate('/hushh-ai/login');
      }
    });

    return unsubscribe;
  }, [navigate]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatState.streamingContent]);

  // ============================================
  // Data Loading
  // ============================================

  const loadInitialData = async () => {
    setIsDataLoading(true);

    try {
      // Load ALL critical data in parallel for maximum speed
      const [user, chatList, limits] = await Promise.all([
        service.getOrCreateUser(),
        service.getChats(),
        service.getMediaLimits(),
      ]);

      if (user) {
        setUserId(user.id);
        // Track product usage for analytics (non-blocking)
        trackProductUsage(PRODUCTS.HUSHH_AI).catch(console.error);
      }

      setChats(chatList);
      setMediaLimits(limits);

      // Restore last active chat from localStorage (Bug #2 fix)
      const persistedChatId = getPersistedChatId();
      if (persistedChatId && chatList.length > 0) {
        // Check if the persisted chat still exists
        const chatExists = chatList.find(c => c.id === persistedChatId);
        if (chatExists) {
          // Load the persisted chat
          await loadChat(persistedChatId);
        } else {
          // Chat was deleted, clear persisted ID
          setPersistedChatId(null);
        }
      }

      // Load profile separately with retry (non-blocking)
      loadUserProfile();
    } finally {
      setIsDataLoading(false);
    }
  };

  const loadUserProfile = async (retries = 3) => {
    try {
      const profile = await service.getUserProfile();
      setUserProfile(profile);
    } catch (error) {
      console.error('Profile load failed:', error);
      if (retries > 0) {
        console.log(`Retrying profile fetch... (${retries} attempts left)`);
        setTimeout(() => loadUserProfile(retries - 1), 2000);
      } else {
        // Set to null after all retries exhausted
        setUserProfile(null);
        toast({
          title: 'Failed to load profile',
          description: 'Some features may be limited',
          status: 'warning',
          duration: 5000,
        });
      }
    }
  };

  const loadChat = async (chatId: string) => {
    const [chat, msgs] = await Promise.all([
      service.getChatById(chatId),
      service.getMessages(chatId),
    ]);
    if (chat) {
      setCurrentChat(chat);
      setMessages(msgs);
    }
  };

  // ============================================
  // Handlers
  // ============================================

  const handleNewChat = async () => {
    const chat = await service.createChat();
    if (chat) {
      setChats((prev) => [chat, ...prev]);
      setCurrentChat(chat);
      setMessages([]);
      // Persist the new chat ID (Bug #2 fix)
      setPersistedChatId(chat.id);
      inputRef.current?.focus();
    }
  };

  const handleSelectChat = async (chat: HushhChat) => {
    setCurrentChat(chat);
    // Persist the selected chat ID (Bug #2 fix)
    setPersistedChatId(chat.id);
    await loadChat(chat.id);
  };

  const handleDeleteChat = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await service.deleteChat(chatId);
    if (success) {
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (currentChat?.id === chatId) {
        setCurrentChat(null);
        setMessages([]);
        // Clear persisted chat ID if deleted (Bug #2 fix)
        setPersistedChatId(null);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length + selectedFiles.length > mediaLimits?.remainingUploads! || 0) {
      toast({
        title: BRANDING.messages.uploadLimit,
        status: 'warning',
        duration: 3000,
      });
      return;
    }
    setSelectedFiles((prev) => [...prev, ...files]);
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() && selectedFiles.length === 0) return;
    if (chatState.isSending) return;

    let chatId = currentChat?.id;

    // Create new chat if none selected
    if (!chatId) {
      const newChat = await service.createChat(inputValue.slice(0, 50));
      if (!newChat) return;
      chatId = newChat.id;
      setCurrentChat(newChat);
      setChats((prev) => [newChat, ...prev]);
    }

    setChatState((prev) => ({ ...prev, isSending: true, error: null }));

    try {
      // Upload files if any
      const mediaUrls: string[] = [];
      for (const file of selectedFiles) {
        const url = await service.uploadMedia(file);
        if (url) mediaUrls.push(url);
      }
      setSelectedFiles([]);

      // Add user message
      const userMessage = await service.addMessage(chatId, 'user', inputValue, mediaUrls);
      if (userMessage) {
        setMessages((prev) => [...prev, userMessage]);
      }

      const userInput = inputValue;
      setInputValue('');

      // Call AI
      setChatState((prev) => ({ ...prev, isStreaming: true, streamingContent: '' }));

      await streamAIResponse(chatId, userInput, mediaUrls, userId);

    } catch (error) {
      console.error('Error sending message:', error);
      setChatState((prev) => ({
        ...prev,
        error: BRANDING.messages.error,
        isSending: false,
        isStreaming: false,
      }));
    }
  };

  const streamAIResponse = async (chatId: string, message: string, mediaUrls: string[], currentUserId: string | null) => {
    // Create abort controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const gcpApiBaseUrl = config.GCP_API_BASE_URL;
      const firebaseApiKey = config.FIREBASE_API_KEY;

      const response = await fetch(`${gcpApiBaseUrl}/functions/v1/hushh-ai-chat`, {
        method: 'POST',
        signal: controller.signal, // Add abort signal
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firebaseApiKey}`,
        },
        body: JSON.stringify({
          message,
          chatId,
          userId: currentUserId, // For Redis rate limiting
          mediaUrls,
          history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        throw new Error('AI response failed');
      }

      // Check for calendar event metadata in response headers
      // Capture metadata in closure to prevent race conditions
      const capturedMetadata: MessageMetadata | undefined = (() => {
        try {
          const eventHeader = response.headers.get('x-calendar-event');
          if (!eventHeader) return undefined;

          // Validate header size (prevent truncated JSON)
          if (eventHeader.length > 8192) {
            throw new Error('Invalid calendar event header size');
          }

          const eventData = JSON.parse(eventHeader);

          // Validate required fields
          if (!eventData.id || !eventData.summary || !eventData.startTime || !eventData.endTime) {
            throw new Error('Missing required calendar event fields');
          }

          // Validate date formats
          if (isNaN(Date.parse(eventData.startTime)) || isNaN(Date.parse(eventData.endTime))) {
            throw new Error('Invalid date format in calendar event');
          }

          return { calendarEvent: eventData };

        } catch (e) {
          console.error('Failed to parse calendar event data:', e);
          toast({
            description: 'Please check your Google Calendar directly',
            status: 'warning',
            duration: 5000,
            isClosable: true,
          });
          return undefined;
        }
      })();

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullContent += chunk;
        setChatState((prev) => ({ ...prev, streamingContent: fullContent }));
      }

      // Save assistant message with captured metadata (prevents race conditions)
      const assistantMessage = await service.addMessage(chatId, 'assistant', fullContent, [], capturedMetadata);
      if (assistantMessage) {
        setMessages((prev) => [...prev, assistantMessage]);
      }

      setChatState((prev) => ({
        ...prev,
        isSending: false,
        isStreaming: false,
        streamingContent: ''
      }));

      // Refresh media limits
      const limits = await service.getMediaLimits();
      setMediaLimits(limits);

    } catch (error) {
      // Handle abort gracefully
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Streaming cancelled by user');
        setChatState((prev) => ({
          ...prev,
          isSending: false,
          isStreaming: false,
          streamingContent: ''
        }));
        return;
      }

      console.error('Streaming error:', error);
      setChatState((prev) => ({
        ...prev,
        error: BRANDING.messages.error,
        isSending: false,
        isStreaming: false,
        streamingContent: '',
      }));
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut) return; // Prevent double clicks

    // Warn if unsent content
    if (inputValue.trim() || selectedFiles.length > 0) {
      const confirmed = window.confirm('You have unsent content. Continue logout?');
      if (!confirmed) return;
    }

    setIsLoggingOut(true);

    try {
      // Cancel streaming if active
      if (chatState.isStreaming && abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Clear all caches on logout (Bug fix #4)
      setIsCachedAuth(false);
      setPersistedChatId(null);
      sessionStorage.removeItem(STORAGE_KEYS.HAS_VISITED);

      // Clear local state BEFORE logout
      setChats([]);
      setMessages([]);
      setCurrentChat(null);
      setInputValue('');
      setSelectedFiles([]);
      setUserProfile(null);
      setMediaLimits(null);
      setChatState({
        isTyping: false,
        isSending: false,
        isStreaming: false,
        streamingContent: '',
        error: null,
      });

      const success = await service.signOut();
      if (!success) {
        throw new Error('Sign out failed');
      }

      navigate('/hushh-ai/login');
    } catch (error) {
      console.error('Logout error:', error);
      toast({
        title: 'Logout failed',
        description: 'Please try again',
        status: 'error',
        duration: 3000,
      });
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleAccountDeleted = () => {
    // Cancel streaming if active
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Clear all caches on account deletion (Bug fix #4)
    setIsCachedAuth(false);
    setPersistedChatId(null);
    sessionStorage.removeItem(STORAGE_KEYS.HAS_VISITED);

    onCloseDeleteModal();
    navigate('/hushh-ai/login');
  };

  // ============================================
  // Render
  // ============================================

  if (isLoading) {
    return (
      <Flex
        h="100vh"
        bg={THEME.colors.background}
        align="center"
        justify="center"
      >
        <VStack spacing={4}>
          <Spinner size="lg" color={THEME.colors.accent} />
          <Text color={THEME.colors.textSecondary}>Loading Hushh AI...</Text>
        </VStack>
      </Flex>
    );
  }

  return (
    <Flex h="100vh" bg={THEME.colors.background}>
      {/* Sidebar */}
      <AnimatePresence>
        {sidebarOpen && (
          <MotionBox
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            bg={THEME.colors.sidebarBg}
            borderRight={`1px solid ${THEME.colors.border}`}
            overflow="hidden"
          >
            <VStack h="full" p={4} spacing={4} align="stretch">
              {/* Header */}
              <HStack justify="space-between">
                <Text
                  fontSize={THEME.fontSizes.lg}
                  fontWeight={THEME.fontWeights.semibold}
                  color={THEME.colors.textPrimary}
                >
                  {BRANDING.productName}
                </Text>
                <IconButton
                  aria-label="Close sidebar"
                  icon={<SidebarIcon />}
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarOpen(false)}
                />
              </HStack>

              {/* New Chat Button */}
              <Box
                as="button"
                w="full"
                p={3}
                borderRadius={THEME.borderRadius.md}
                border={`1px solid ${THEME.colors.border}`}
                bg={THEME.colors.surface}
                _hover={{ bg: THEME.colors.surfaceHover }}
                transition={THEME.transitions.fast}
                onClick={handleNewChat}
              >
                <HStack>
                  <PlusIcon />
                  <Text fontSize={THEME.fontSizes.sm}>{BRANDING.messages.newChat}</Text>
                </HStack>
              </Box>

              {/* Chat List */}
              <VStack
                flex={1}
                spacing={1}
                align="stretch"
                overflowY="auto"
                css={{
                  '&::-webkit-scrollbar': { width: '4px' },
                  '&::-webkit-scrollbar-thumb': { background: THEME.colors.border, borderRadius: '2px' },
                }}
              >
                {/* Shimmer loading state for chat list */}
                {isDataLoading && chats.length === 0 ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <HStack key={`skeleton-${i}`} p={3} spacing={2}>
                      <Skeleton height="18px" flex={1} borderRadius={THEME.borderRadius.sm} startColor={THEME.colors.border} endColor={THEME.colors.backgroundSecondary} />
                    </HStack>
                  ))
                ) : chats.length === 0 ? (
                  <VStack py={8} spacing={2}>
                    <Text fontSize={THEME.fontSizes.sm} color={THEME.colors.textSecondary}>
                      No chats yet
                    </Text>
                    <Text fontSize={THEME.fontSizes.xs} color={THEME.colors.textPlaceholder}>
                      Start a new conversation
                    </Text>
                  </VStack>
                ) : (
                  chats.map((chat) => (
                    <HStack
                      key={chat.id}
                      p={3}
                      borderRadius={THEME.borderRadius.sm}
                      bg={currentChat?.id === chat.id ? THEME.colors.sidebarActive : 'transparent'}
                      _hover={{ bg: THEME.colors.sidebarHover }}
                      cursor="pointer"
                      onClick={() => handleSelectChat(chat)}
                      justify="space-between"
                    >
                      <Text
                        fontSize={THEME.fontSizes.sm}
                        noOfLines={1}
                        color={THEME.colors.textPrimary}
                      >
                        {chat.title}
                      </Text>
                      <IconButton
                        aria-label="Delete chat"
                        icon={<TrashIcon />}
                        variant="ghost"
                        size="xs"
                        opacity={0.5}
                        _hover={{ opacity: 1 }}
                        onClick={(e) => handleDeleteChat(chat.id, e)}
                      />
                    </HStack>
                  ))
                )}
              </VStack>

              {/* Media Limit Indicator */}
              {isDataLoading && !mediaLimits ? (
                <Box p={3} bg={THEME.colors.backgroundSecondary} borderRadius={THEME.borderRadius.sm}>
                  <Skeleton height="12px" width="70%" mb={2} borderRadius="sm" startColor={THEME.colors.border} endColor={THEME.colors.backgroundSecondary} />
                  <Skeleton height="4px" borderRadius="full" startColor={THEME.colors.border} endColor={THEME.colors.backgroundSecondary} />
                </Box>
              ) : mediaLimits && (
                <Box p={3} bg={THEME.colors.backgroundSecondary} borderRadius={THEME.borderRadius.sm}>
                  <Text fontSize={THEME.fontSizes.xs} color={THEME.colors.textSecondary}>
                    Media uploads today: {mediaLimits.dailyUploads}/{mediaLimits.maxDailyUploads}
                  </Text>
                  <Box
                    mt={2}
                    h="4px"
                    bg={THEME.colors.border}
                    borderRadius="full"
                    overflow="hidden"
                  >
                    <Box
                      h="full"
                      w={`${(mediaLimits.dailyUploads / mediaLimits.maxDailyUploads) * 100}%`}
                      bg={THEME.colors.accent}
                      transition={THEME.transitions.normal}
                    />
                  </Box>
                </Box>
              )}

              {/* Profile Section */}
              <Divider borderColor={THEME.colors.border} />
              {userProfile === undefined ? (
                // Loading state
                <Box p={3}>
                  <Skeleton height="48px" borderRadius={THEME.borderRadius.sm} />
                </Box>
              ) : userProfile === null ? (
                // Error state
                <Box p={3} bg="#FEE2E2" borderRadius={THEME.borderRadius.sm}>
                  <Text fontSize={THEME.fontSizes.xs} color="#DC2626">
                    Failed to load profile
                  </Text>
                </Box>
              ) : (
                // Loaded state
                <Menu placement="top-start">
                  <MenuButton
                    as={Box}
                    p={3}
                    borderRadius={THEME.borderRadius.sm}
                    _hover={{ bg: THEME.colors.sidebarHover }}
                    cursor="pointer"
                    transition={THEME.transitions.fast}
                  >
                    <HStack spacing={3}>
                      <Avatar
                        size="sm"
                        name={userProfile.displayName || userProfile.email || 'User'}
                        src={userProfile.avatarUrl || undefined}
                        bg={THEME.colors.accent}
                        color="white"
                      />
                      <VStack align="start" spacing={0} flex={1}>
                        <Tooltip label={userProfile.displayName || 'User'} placement="top">
                          <Text
                            fontSize={THEME.fontSizes.sm}
                            fontWeight={THEME.fontWeights.medium}
                            color={THEME.colors.textPrimary}
                            noOfLines={1}
                          >
                            {userProfile.displayName || 'User'}
                          </Text>
                        </Tooltip>
                        <Tooltip label={userProfile.email || ''} placement="bottom">
                          <Text
                            fontSize={THEME.fontSizes.xs}
                            color={THEME.colors.textSecondary}
                            noOfLines={1}
                          >
                            {userProfile.email || ''}
                          </Text>
                        </Tooltip>
                      </VStack>
                      <ProfileMenuIcon />
                    </HStack>
                  </MenuButton>
                  <MenuList
                    bg={THEME.colors.surface}
                    borderColor={THEME.colors.border}
                    boxShadow={THEME.shadows.md}
                    py={2}
                  >
                    <MenuItem
                      icon={<LogoutIcon />}
                      onClick={handleLogout}
                      isDisabled={isLoggingOut}
                      _hover={{ bg: THEME.colors.sidebarHover }}
                      fontSize={THEME.fontSizes.sm}
                      color={THEME.colors.textPrimary}
                    >
                      {isLoggingOut ? 'Logging out...' : 'Log Out'}
                    </MenuItem>
                    <MenuItem
                      icon={<DeleteIcon />}
                      onClick={onOpenDeleteModal}
                      _hover={{ bg: '#FEE2E2' }}
                      fontSize={THEME.fontSizes.sm}
                      color="#DC2626"
                    >
                      Delete Account
                    </MenuItem>
                  </MenuList>
                </Menu>
              )}
            </VStack>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <Flex flex={1} direction="column">
        {/* Top Bar */}
        <HStack
          p={4}
          borderBottom={`1px solid ${THEME.colors.border}`}
          bg={THEME.colors.surface}
          justifyContent="space-between"
        >
          <HStack spacing={2}>
            {!sidebarOpen && (
              <IconButton
                aria-label="Open sidebar"
                icon={<SidebarIcon />}
                variant="ghost"
                size="sm"
                onClick={() => setSidebarOpen(true)}
              />
            )}
            <Text
              fontWeight={THEME.fontWeights.medium}
              color={THEME.colors.textPrimary}
            >
              {currentChat?.title || BRANDING.productName}
            </Text>
          </HStack>

          {/* Calendar Sidebar Trigger */}
        </HStack>

        {/* Messages */}
        <VStack
          flex={1}
          p={6}
          spacing={6}
          overflowY="auto"
          align="stretch"
          css={{
            '&::-webkit-scrollbar': { width: '6px' },
            '&::-webkit-scrollbar-thumb': { background: THEME.colors.border, borderRadius: '3px' },
          }}
        >
          {messages.length === 0 && !currentChat && (
            <VStack flex={1} justify="center" spacing={4}>
              <Box
                w={16}
                h={16}
                borderRadius="full"
                bg={THEME.colors.accent}
                display="flex"
                alignItems="center"
                justifyContent="center"
              >
                <Text fontSize="2xl" color="white">H</Text>
              </Box>
              <Text
                fontSize={THEME.fontSizes.xl}
                fontWeight={THEME.fontWeights.semibold}
                color={THEME.colors.textPrimary}
              >
                {BRANDING.messages.welcome}
              </Text>
            </VStack>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {/* Streaming Response */}
          {chatState.isStreaming && chatState.streamingContent && (
            <MessageBubble
              message={{
                id: 'streaming',
                chatId: currentChat?.id || '',
                role: 'assistant',
                content: chatState.streamingContent,
                mediaUrls: [],
                createdAt: new Date(),
              }}
              isStreaming
            />
          )}

          {/* Thinking Indicator */}
          {chatState.isSending && !chatState.streamingContent && (
            <HStack spacing={2} p={4}>
              <Spinner size="sm" color={THEME.colors.accent} />
              <Text color={THEME.colors.textSecondary} fontSize={THEME.fontSizes.sm}>
                {BRANDING.messages.thinking}
              </Text>
            </HStack>
          )}

          <div ref={messagesEndRef} />
        </VStack>

        {/* Input Area */}
        <Box p={4} bg={THEME.colors.surface} borderTop={`1px solid ${THEME.colors.border}`}>
          {/* Selected Files Preview */}
          {selectedFiles.length > 0 && (
            <HStack mb={3} spacing={2} flexWrap="wrap">
              {selectedFiles.map((file, index) => (
                <HStack
                  key={index}
                  p={2}
                  bg={THEME.colors.backgroundSecondary}
                  borderRadius={THEME.borderRadius.sm}
                  spacing={2}
                >
                  <Text fontSize={THEME.fontSizes.xs} noOfLines={1} maxW="100px">
                    {file.name}
                  </Text>
                  <IconButton
                    aria-label="Remove file"
                    icon={<CloseIcon />}
                    size="xs"
                    variant="ghost"
                    onClick={() => handleRemoveFile(index)}
                  />
                </HStack>
              ))}
            </HStack>
          )}

          {/* Input Bar */}
          <HStack
            p={3}
            bg={THEME.colors.background}
            borderRadius={THEME.borderRadius.lg}
            border={`1px solid ${THEME.colors.border}`}
            _focusWithin={{ borderColor: THEME.colors.borderFocus }}
          >
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.txt"
              onChange={handleFileSelect}
            />
            <IconButton
              aria-label="Attach file"
              icon={<AttachIcon />}
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              isDisabled={mediaLimits?.remainingUploads === 0}
            />
            <Input
              ref={inputRef}
              flex={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={BRANDING.placeholders.input}
              variant="unstyled"
              fontSize={THEME.fontSizes.md}
              _placeholder={{ color: THEME.colors.textPlaceholder }}
            />
            <IconButton
              aria-label="Send message"
              icon={<SendIcon />}
              variant="ghost"
              size="sm"
              colorScheme="orange"
              onClick={handleSendMessage}
              isDisabled={chatState.isSending || (!inputValue.trim() && selectedFiles.length === 0)}
            />
          </HStack>

          {/* Error Message */}
          {chatState.error && (
            <Text mt={2} color={THEME.colors.error} fontSize={THEME.fontSizes.sm}>
              {chatState.error}
            </Text>
          )}
        </Box>
      </Flex>

      {/* Delete Account Modal */}
      <DeleteAccountModal
        isOpen={isDeleteModalOpen}
        onClose={onCloseDeleteModal}
        onAccountDeleted={handleAccountDeleted}
      />
    </Flex>
  );
}

// ============================================
// Message Bubble Component
// ============================================

interface MessageBubbleProps {
  message: HushhMessage;
  isStreaming?: boolean;
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <Flex justify={isUser ? 'flex-end' : 'flex-start'} direction="column" align={isUser ? 'flex-end' : 'flex-start'}>
      <Box
        maxW="70%"
        p={4}
        borderRadius={THEME.borderRadius.lg}
        bg={isUser ? THEME.colors.userBubble : THEME.colors.assistantBubble}
        boxShadow={isUser ? 'none' : THEME.shadows.sm}
      >
        {/* Media */}
        {message.mediaUrls.length > 0 && (
          <VStack mb={3} spacing={2} align="stretch">
            {message.mediaUrls.map((url, i) => (
              <Box key={i} borderRadius={THEME.borderRadius.sm} overflow="hidden">
                {url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                  <img src={url} alt="Uploaded" style={{ maxWidth: '100%', borderRadius: '8px' }} />
                ) : (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <Text color={THEME.colors.accent} fontSize={THEME.fontSizes.sm}>
                      📎 Attachment
                    </Text>
                  </a>
                )}
              </Box>
            ))}
          </VStack>
        )}

        {/* Content */}
        <Text
          fontSize={THEME.fontSizes.md}
          color={THEME.colors.textPrimary}
          whiteSpace="pre-wrap"
        >
          {message.content}
          {isStreaming && (
            <Box as="span" display="inline-block" w="8px" h="16px" bg={THEME.colors.accent} ml={1} animation="blink 1s infinite" />
          )}
        </Text>
      </Box>

      {/* Calendar Event Card */}
      <Box mt={2} maxW="70%">
      </Box>
    </Flex>
  );
}

// ============================================
// Icons
// ============================================

const SidebarIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const AttachIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const ProfileMenuIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="19" r="1" />
  </svg>
);

const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const DeleteIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);
