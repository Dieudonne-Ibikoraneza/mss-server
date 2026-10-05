import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedPreferenceQuestions } from './profiling-questions';

const prisma = new PrismaClient();
seedPreferenceQuestions(prisma)
  .then((result) => console.log('Preference questions seeded:', result))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
