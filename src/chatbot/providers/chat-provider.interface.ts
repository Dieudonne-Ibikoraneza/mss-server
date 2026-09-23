export const CHAT_PROVIDER = Symbol('CHAT_PROVIDER');

export interface ChatContextMessage {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
}

/** A compact, grounding-only view of a real catalog product — never send full DB rows to the model. */
export interface ChatProductCandidate {
  id: string;
  name: string;
  description: string | null;
  size: string;
  suitableFor: string;
  roomTypes: string[];
  price: number;
  currency: string;
  stockStatus: string;
}

export interface ChatRecommendationPick {
  /** The floor tile for a bathroom combo pick, or the sole product otherwise. */
  productId: string;
  /** Present only for a bathroom pick: a second real product, suited for WALL
   * (or BOTH), to be shown installed on the wall alongside `productId` on the
   * floor — bathrooms are the one room type where customers commonly tile
   * only the lower portion of the wall as well as the floor. */
  wallProductId?: string;
  matchScore: number;
  reason: string;
}

export interface ChatProviderReplyInput {
  /** Prior turns of this conversation — USER/ASSISTANT only. */
  messages: ChatContextMessage[];
  language: 'EN' | 'RW';
  /** Real, currently-active products the model is allowed to recommend from — nothing else. */
  candidates: ChatProductCandidate[];
  /** Store Q&A pairs to ground general questions the model shouldn't have to guess at. */
  knowledgeBase: { question: string; answer: string }[];
  /** True only when the latest customer turn explicitly asks for a fresh
   * product selection, rather than discussing products already shown. */
  allowRecommendations: boolean;
}

export interface ChatProviderReplyResult {
  reply: string;
  /** Empty when the conversation doesn't yet warrant a recommendation. */
  picks: ChatRecommendationPick[];
}

export interface ChatProvider {
  reply(input: ChatProviderReplyInput): Promise<ChatProviderReplyResult>;
}
