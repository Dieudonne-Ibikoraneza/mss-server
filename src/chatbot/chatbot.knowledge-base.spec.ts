import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Language, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { StorageService } from '@/storage/storage.service';
import { ChatbotService } from './chatbot.service';
import { UpsertKnowledgeBaseEntryDto, UpdateKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
import { ChatProvider } from './providers/chat-provider.interface';
import { RecommendationImageProvider } from './providers/recommendation-image.provider';
import { RoomTileEditProvider } from './providers/room-tile-provider.interface';

describe('English-only knowledge base', () => {
  const entry = {
    id: 'entry',
    question: 'Do you deliver?',
    answer: 'Yes.',
    tags: [],
    language: Language.EN,
  };
  let service: ChatbotService;
  let prisma: {
    knowledgeBaseEntry: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    chatConversation: { findFirst: jest.Mock };
    chatMessage: { create: jest.Mock; findMany: jest.Mock };
    product: { findMany: jest.Mock };
    recommendation: { count: jest.Mock };
    platformSetting: { findUnique: jest.Mock };
  };
  let provider: { reply: jest.MockedFunction<ChatProvider['reply']> };

  beforeEach(() => {
    prisma = {
      knowledgeBaseEntry: {
        findMany: jest.fn().mockResolvedValue([entry]),
        findUnique: jest.fn().mockResolvedValue(entry),
        create: jest.fn().mockResolvedValue(entry),
        update: jest.fn().mockResolvedValue(entry),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      chatConversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation',
          title: 'Room',
          userId: 'user',
          sessionId: 'session',
          language: Language.RW,
        }),
      },
      chatMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      recommendation: { count: jest.fn().mockResolvedValue(0) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    provider = { reply: jest.fn().mockResolvedValue({ reply: 'Reply', picks: [] }) };
    service = new ChatbotService(
      prisma as unknown as PrismaService,
      {} as EventsService,
      provider,
      {} as RecommendationImageProvider,
      {} as RoomTileEditProvider,
      {} as StorageService,
    );
  });

  it('lists only English entries for admins, including inactive entries', async () => {
    await service.listKnowledgeBaseForAdmin();
    expect(prisma.knowledgeBaseEntry.findMany).toHaveBeenCalledWith({
      where: { language: Language.EN },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('lists only active English entries for the public knowledge base', async () => {
    await service.listKnowledgeBase();
    expect(prisma.knowledgeBaseEntry.findMany).toHaveBeenCalledWith({
      where: { isActive: true, language: Language.EN },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('grounds a Kinyarwanda conversation in English entries while retaining its reply language', async () => {
    await service.sendMessage(
      { sessionId: 'session', content: 'Do you deliver?' },
      'user',
      Role.CLIENT,
    );
    expect(prisma.knowledgeBaseEntry.findMany).toHaveBeenCalledWith({
      where: { isActive: true, language: Language.EN },
      take: 10,
    });
    expect(provider.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        language: Language.RW,
        knowledgeBase: [{ question: entry.question, answer: entry.answer }],
      }),
    );
  });

  it('creates one English entry without generating translated copies', async () => {
    await service.createKnowledgeBaseEntry({ question: entry.question, answer: entry.answer });
    expect(prisma.knowledgeBaseEntry.create).toHaveBeenCalledTimes(1);
    expect(prisma.knowledgeBaseEntry.create).toHaveBeenCalledWith({
      data: { question: entry.question, answer: entry.answer, tags: [], language: Language.EN },
    });
  });

  it('keeps edits and activation changes English-only', async () => {
    await service.updateKnowledgeBaseEntry(entry.id, { isActive: false });
    expect(prisma.knowledgeBaseEntry.findUnique).toHaveBeenCalledWith({
      where: { id: entry.id, language: Language.EN },
    });
    expect(prisma.knowledgeBaseEntry.update).toHaveBeenCalledWith({
      where: { id: entry.id },
      data: { isActive: false, language: Language.EN },
    });
  });

  it('does not allow editing or deleting hidden legacy entries', async () => {
    prisma.knowledgeBaseEntry.findUnique.mockResolvedValue(null);
    await expect(
      service.updateKnowledgeBaseEntry('legacy-rw', { answer: 'Changed' }),
    ).rejects.toThrow('Knowledge base entry not found.');
    await expect(service.deleteKnowledgeBaseEntry('legacy-rw')).rejects.toThrow(
      'Knowledge base entry not found.',
    );
    expect(prisma.knowledgeBaseEntry.update).not.toHaveBeenCalled();
    expect(prisma.knowledgeBaseEntry.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['RW', 'FR', ''])(
    'rejects %s as a knowledge-base language on both create and update',
    async (language) => {
      const create = await validate(
        plainToInstance(UpsertKnowledgeBaseEntryDto, {
          question: entry.question,
          answer: entry.answer,
          language,
        }),
      );
      const update = await validate(plainToInstance(UpdateKnowledgeBaseEntryDto, { language }));
      expect(create.some((error) => error.property === 'language')).toBe(true);
      expect(update.some((error) => error.property === 'language')).toBe(true);
    },
  );

  it('accepts English and defaults new entries to English', async () => {
    const defaulted = plainToInstance(UpsertKnowledgeBaseEntryDto, {
      question: entry.question,
      answer: entry.answer,
    });
    expect(defaulted.language).toBe(Language.EN);
    expect(await validate(defaulted)).toEqual([]);
    expect(
      await validate(plainToInstance(UpdateKnowledgeBaseEntryDto, { language: Language.EN })),
    ).toEqual([]);
  });
});
