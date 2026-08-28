import { Injectable, Logger } from '@nestjs/common';
import type {
  ChatProvider,
  ChatProviderReplyInput,
  ChatProviderReplyResult,
} from './chat-provider.interface';

/**
 * Placeholder conversation model per doc section 6 ("Conversation (chatbot)
 * model - handles product Q&A and comparisons"). Used whenever AI_CHAT_PROVIDER
 * isn't set to a real provider; the rest of ChatbotService is provider-agnostic.
 */
@Injectable()
export class StubChatProvider implements ChatProvider {
  private readonly logger = new Logger(StubChatProvider.name);

  reply(input: ChatProviderReplyInput): Promise<ChatProviderReplyResult> {
    const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'USER');
    this.logger.debug(`Stub reply for: ${lastUserMessage?.content ?? ''}`);

    return Promise.resolve({
      reply:
        input.language === 'RW'
          ? "Murakoze kubaza! Ubu ni igisubizo cy'agateganyo mu gihe umuyoboro w'ubwenge bw'ikoranabuhanga utegurwa."
          : 'Thanks for asking! This is a placeholder reply while the AI provider is being configured.',
      picks: [],
    });
  }
}
