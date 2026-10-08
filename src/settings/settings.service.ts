import { Injectable, Logger } from '@nestjs/common';
import { badRequest, notFound } from '@/common/errors/app-error';
import { Language, RoomType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { PAYMENT_SETTING_KEYS } from './payment-details';
import { validateSettingValue } from './settings.validation';
import {
  PUBLIC_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  isSettingKey,
  type PublicSettingKey,
  type SettingKey,
} from './settings.defaults';
import {
  CreateProfilingQuestionDto,
  ReorderProfilingQuestionsDto,
  UpdateProfilingQuestionDto,
} from './dto/profiling-question.dto';
import {
  CreateFollowUpQuestionDto,
  ReorderFollowUpQuestionsDto,
  UpdateFollowUpQuestionDto,
} from './dto/follow-up-question.dto';

/**
 * Admin-panel configuration (doc 3.10 "Configure system settings"): the
 * key/value platform settings and the customer-profiling questions that drive
 * the AI recommendation flow.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Stored rows merged over the defaults, so callers always get every key. */
  async findAll(): Promise<Record<SettingKey, unknown>> {
    const rows = await this.prisma.platformSetting.findMany();
    const settings = { ...SETTINGS_DEFAULTS } as Record<SettingKey, unknown>;

    for (const row of rows) {
      if (isSettingKey(row.key)) settings[row.key] = row.value;
    }
    return settings;
  }

  async findPublic(): Promise<Record<PublicSettingKey, unknown>> {
    const settings = await this.findAll();
    return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, settings[key]])) as Record<
      PublicSettingKey,
      unknown
    >;
  }

  async update(patch: Record<string, unknown>, actingUserId?: string) {
    const entries = Object.entries(patch);
    const unknown = entries.filter(([key]) => !isSettingKey(key)).map(([key]) => key);
    if (unknown.length > 0) {
      throw badRequest('settings.unknownSettings', 'Unknown setting(s): {{keys}}.', {
        keys: unknown.join(', '),
      });
    }
    // Every value is checked against what its setting holds, and text is trimmed.
    const validated = entries.map(
      ([key, value]) => [key, validateSettingValue(key as SettingKey, value)] as const,
    );

    // Where customers pay is what a fraudster would change: leave a trail of who
    // changed which field, and when.
    const before = await this.findAll();
    const changedPaymentFields = validated
      .filter(([key]) => (PAYMENT_SETTING_KEYS as readonly string[]).includes(key))
      .filter(([key, value]) => before[key as SettingKey] !== value)
      .map(([key]) => key);

    await this.prisma.$transaction(
      validated.map(([key, value]) =>
        this.prisma.platformSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        }),
      ),
    );

    if (changedPaymentFields.length > 0) {
      this.logger.warn(
        `Payment details changed by user ${actingUserId ?? 'unknown'}: ${changedPaymentFields.join(', ')}`,
      );
    }
    return this.findAll();
  }

  // --- Suggested chatbot follow-ups ----------------------------------------

  listFollowUpQuestions() {
    return this.prisma.chatbotFollowUp.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, text: true, position: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  listAdminFollowUpQuestions() {
    return this.prisma.chatbotFollowUp.findMany({
      where: { deletedAt: null },
      select: { id: true, text: true, position: true, isActive: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async createFollowUpQuestion(dto: CreateFollowUpQuestionDto) {
    const last = await this.prisma.chatbotFollowUp.findFirst({
      where: { deletedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.chatbotFollowUp.create({
      data: { ...dto, position: (last?.position ?? -1) + 1 },
    });
  }

  async updateFollowUpQuestion(id: string, dto: UpdateFollowUpQuestionDto) {
    await this.findFollowUpQuestion(id);
    return this.prisma.chatbotFollowUp.update({ where: { id }, data: dto });
  }

  async removeFollowUpQuestion(id: string) {
    await this.findFollowUpQuestion(id);
    // A tombstone also prevents a later seed run from restoring a deleted default.
    await this.prisma.chatbotFollowUp.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async findFollowUpQuestion(id: string) {
    const row = await this.prisma.chatbotFollowUp.findUnique({ where: { id } });
    if (!row || row.deletedAt)
      throw notFound('settings.followUpNotFound', 'Follow-up question not found.');
    return row;
  }

  async reorderFollowUpQuestions(dto: ReorderFollowUpQuestionsDto) {
    // Validate the complete list before writing so a stale admin screen cannot
    // silently leave newly added suggestions in the wrong position.
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.chatbotFollowUp.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      const ids = new Set(dto.ids);
      if (
        ids.size !== dto.ids.length ||
        rows.length !== ids.size ||
        rows.some((row) => !ids.has(row.id))
      ) {
        throw badRequest(
          'settings.followUpOrderChanged',
          'The follow-up list has changed. Refresh it and try again.',
        );
      }
      await Promise.all(
        dto.ids.map((id, position) =>
          tx.chatbotFollowUp.update({ where: { id }, data: { position } }),
        ),
      );
    });
    return this.listAdminFollowUpQuestions();
  }

  // --- Customer profiling questions -----------------------------------------

  listQuestions(language?: Language, includeInactive = false) {
    return this.prisma.profilingQuestion.findMany({
      where: { language, isActive: includeInactive ? undefined : true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Questions to ask for a given room type: the always-on ones (empty `roomTypes`) plus every
   * conditional question that lists this room among its own — a question can apply to more
   * than one room type. */
  listQuestionsForRoom(roomType: RoomType, language?: Language) {
    return this.prisma.profilingQuestion.findMany({
      where: {
        language,
        isActive: true,
        OR: [{ roomTypes: { isEmpty: true } }, { roomTypes: { has: roomType } }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createQuestion(dto: CreateProfilingQuestionDto) {
    const position = dto.position ?? (await this.nextPosition());
    return this.prisma.profilingQuestion.create({ data: { ...dto, position } });
  }

  private async nextPosition() {
    const last = await this.prisma.profilingQuestion.findFirst({
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  }

  async updateQuestion(id: string, dto: UpdateProfilingQuestionDto) {
    await this.findQuestion(id);
    return this.prisma.profilingQuestion.update({ where: { id }, data: dto });
  }

  /** Soft delete, so an answered question's history stays resolvable. */
  async removeQuestion(id: string) {
    await this.findQuestion(id);
    await this.prisma.profilingQuestion.update({ where: { id }, data: { isActive: false } });
  }

  async reorderQuestions(dto: ReorderProfilingQuestionsDto) {
    await this.prisma.$transaction(
      dto.questions.map((question) =>
        this.prisma.profilingQuestion.update({
          where: { id: question.id },
          data: { position: question.position },
        }),
      ),
    );
    return this.listQuestions();
  }

  private async findQuestion(id: string) {
    const question = await this.prisma.profilingQuestion.findUnique({ where: { id } });
    if (!question) throw notFound('settings.questionNotFound', 'Profiling question not found.');
    return question;
  }
}
