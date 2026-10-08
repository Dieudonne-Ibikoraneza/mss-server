import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import {
  CreateFollowUpQuestionDto,
  ReorderFollowUpQuestionsDto,
  UpdateFollowUpQuestionDto,
} from './dto/follow-up-question.dto';

const firstId = 'f55ef9c5-c69a-4501-91a1-e981ce7cbcd4';
const secondId = 'cda16003-03e4-432f-af34-d3d7b54c2ee3';
const date = new Date('2026-10-08T12:00:00Z');
const initialRows = [
  {
    id: firstId,
    text: 'A customized question?',
    position: 0,
    isActive: true,
    createdAt: date,
    updatedAt: date,
    deletedAt: null as Date | null,
  },
  {
    id: secondId,
    text: 'Hidden question?',
    position: 1,
    isActive: false,
    createdAt: date,
    updatedAt: date,
    deletedAt: null as Date | null,
  },
];

describe('database-backed follow-up customization', () => {
  const setup = () => {
    const rows = initialRows.map((row) => ({ ...row }));
    const delegate = {
      findMany: jest.fn(
        ({
          where,
          select,
        }: {
          where?: { isActive?: boolean; deletedAt?: null };
          select?: Record<string, boolean>;
        } = {}) =>
          Promise.resolve(
            rows
              .filter((row) => where?.isActive === undefined || row.isActive === where.isActive)
              .filter((row) => where?.deletedAt === undefined || row.deletedAt === null)
              .sort((a, b) => a.position - b.position)
              .map((row) =>
                select
                  ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))
                  : row,
              ),
          ),
      ),
      findFirst: jest.fn().mockResolvedValue({ position: 1 }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      ),
      create: jest.fn(({ data }: { data: Prisma.ChatbotFollowUpCreateInput }) =>
        Promise.resolve({ ...data, id: 'new' }),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<(typeof rows)[number]> }) => {
          const row = rows.find((item) => item.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    };
    const prisma = {
      chatbotFollowUp: delegate,
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ chatbotFollowUp: delegate }),
    };
    return { service: new SettingsService(prisma as never), delegate };
  };

  it('serves only active suggestions using the stored question text', async () => {
    const { service, delegate } = setup();
    expect(await service.listFollowUpQuestions()).toEqual([
      { id: firstId, text: 'A customized question?', position: 0 },
    ]);
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, deletedAt: null } }),
    );
  });

  it('retains disabled suggestions for admins and supports editing and reactivation', async () => {
    const { service } = setup();
    expect(await service.listAdminFollowUpQuestions()).toHaveLength(2);
    await service.updateFollowUpQuestion(secondId, {
      text: 'Edited suggestion?',
      isActive: true,
    });
    expect(await service.listFollowUpQuestions()).toEqual([
      { id: firstId, text: 'A customized question?', position: 0 },
      { id: secondId, text: 'Edited suggestion?', position: 1 },
    ]);
    await service.updateFollowUpQuestion(firstId, { isActive: false });
    expect(await service.listFollowUpQuestions()).toEqual([
      { id: secondId, text: 'Edited suggestion?', position: 1 },
    ]);
    expect(await service.listAdminFollowUpQuestions()).toHaveLength(2);
  });

  it('adds new questions after existing rows, including disabled rows', async () => {
    const { service, delegate } = setup();
    await service.createFollowUpQuestion({ text: 'New question?' });
    expect(delegate.create).toHaveBeenCalledWith({
      data: { text: 'New question?', position: 2 },
    });
  });

  it('saves the complete ordering and returns the admin list including disabled rows', async () => {
    const { service } = setup();
    const rows = await service.reorderFollowUpQuestions({ ids: [secondId, firstId] });
    expect(rows.map((row) => [row.id, row.position])).toEqual([
      [secondId, 0],
      [firstId, 1],
    ]);
  });

  it.each([[firstId], [firstId, firstId], [firstId, 'other']])(
    'rejects incomplete, duplicate or stale orders without writes: %j',
    async (...ids: string[]) => {
      const { service, delegate } = setup();
      await expect(service.reorderFollowUpQuestions({ ids })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(delegate.update).not.toHaveBeenCalled();
    },
  );

  it('removes deleted questions from both lists and prevents further edits', async () => {
    const { service } = setup();
    await service.removeFollowUpQuestion(firstId);
    expect(await service.listFollowUpQuestions()).toEqual([]);
    const admin = await service.listAdminFollowUpQuestions();
    expect(admin.map((row) => row.id)).toEqual([secondId]);
    await expect(
      service.updateFollowUpQuestion(firstId, { isActive: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      (await service.reorderFollowUpQuestions({ ids: [secondId] })).map((row) => row.id),
    ).toEqual([secondId]);
  });

  it('rejects updates to nonexistent questions', async () => {
    const { service, delegate } = setup();
    await expect(
      service.updateFollowUpQuestion('missing', { isActive: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(delegate.update).not.toHaveBeenCalled();
  });
});

describe('follow-up request validation', () => {
  it('trims the required question before storing it', async () => {
    const dto = plainToInstance(CreateFollowUpQuestionDto, {
      text: '  English?  ',
      isActive: false,
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.text).toBe('English?');
  });

  it('rejects missing, blank or oversized text, null updates and nonboolean status', async () => {
    for (const body of [
      {},
      { text: ' ' },
      { text: 'x'.repeat(301) },
      { text: 'Question?', isActive: 'true' },
    ]) {
      expect(
        (await validate(plainToInstance(CreateFollowUpQuestionDto, body))).length,
      ).toBeGreaterThan(0);
    }
    for (const body of [{ text: null }, { isActive: null }, { text: '   ' }]) {
      expect(
        (await validate(plainToInstance(UpdateFollowUpQuestionDto, body))).length,
      ).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(UpdateFollowUpQuestionDto, { isActive: false }))).toEqual(
      [],
    );
  });

  it('rejects duplicate IDs and malformed IDs at the route boundary', async () => {
    for (const ids of [[], ['bad-id'], [firstId, firstId]]) {
      expect(
        (await validate(plainToInstance(ReorderFollowUpQuestionsDto, { ids }))).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('follow-up administration is admin-only', () => {
  const reflector = new Reflector();
  // Reflection inspects the original handler without invoking an unbound method.
  const handlers = SettingsController.prototype as unknown as Record<string, () => void>;
  it.each([
    'listAdminFollowUpQuestions',
    'createFollowUpQuestion',
    'updateFollowUpQuestion',
    'removeFollowUpQuestion',
    'reorderFollowUpQuestions',
  ] as const)('%s rejects every other role and unauthenticated requests', (handler) => {
    const allowed = (role?: Role) =>
      new RolesGuard(reflector).canActivate({
        getHandler: () => handlers[handler],
        getClass: () => SettingsController,
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
      } as unknown as ExecutionContext);
    expect(allowed(Role.ADMIN)).toBe(true);
    for (const role of [
      undefined,
      Role.CLIENT,
      Role.SALES_PERSON,
      Role.STOCK_MANAGER,
      Role.DATA_ANALYST,
    ])
      expect(() => allowed(role)).toThrow(ForbiddenException);
    expect(reflector.get(IS_PUBLIC_KEY, handlers[handler])).toBeUndefined();
  });

  it('exposes only the active-list endpoint publicly', () => {
    expect(reflector.get(IS_PUBLIC_KEY, handlers.listFollowUpQuestions)).toBe(true);
  });
});
