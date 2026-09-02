import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __crezPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__crezPrisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') global.__crezPrisma = prisma;

export type { PrismaClient } from '@prisma/client';
export { Prisma } from '@prisma/client';
