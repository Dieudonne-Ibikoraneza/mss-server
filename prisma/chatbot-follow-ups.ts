import { PrismaClient } from '@prisma/client';

export const DEFAULT_FOLLOW_UPS = [
  {
    id: '824045b6-fcc5-5d5f-b0c6-22a8c30a80db',
    text: 'I need premium large-format slabs for a grand living room.',
    position: 0,
  },
  {
    id: '49d77bb9-d77a-5a44-bdcd-f8873597c869',
    text: 'What tiles work best for a bathroom — floor and walls?',
    position: 1,
  },
  {
    id: '1dbb2b84-3d46-56fa-9fa9-f843e67f6253',
    text: 'What tiles are best for a modern kitchen?',
    position: 2,
  },
  {
    id: 'f0181e3c-f718-5720-9e60-bbde618c0af5',
    text: 'Show me the most durable floor tiles.',
    position: 3,
  },
];

/** Insert missing defaults without overwriting edits, ordering, or disabled suggestions. */
export async function seedChatbotFollowUps(prisma: PrismaClient) {
  await prisma.$transaction(
    DEFAULT_FOLLOW_UPS.map((row) =>
      prisma.chatbotFollowUp.upsert({ where: { id: row.id }, create: row, update: {} }),
    ),
  );
  return { defaults: DEFAULT_FOLLOW_UPS.length };
}
