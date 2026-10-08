import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedChatbotFollowUps } from './chatbot-follow-ups';

const prisma = new PrismaClient();
seedChatbotFollowUps(prisma)
  .then((result) => console.log('Chatbot follow-up questions seeded:', result))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Could not seed follow-up questions.');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
