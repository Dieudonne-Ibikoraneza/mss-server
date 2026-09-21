import { Logger } from '@nestjs/common';

const logger = new Logger('AfterCommit');

/**
 * Follow-up work that runs after the database write it follows has already committed, so a
 * failure there (Redis down, a mail or push hiccup) must not turn a successful order or stock change into an error
 * response (the caller would retry something that already happened). A stale entry is
 * harmless — every cached entry expires on its own within a minute or two — so the
 * failure is logged and swallowed.
 */
export async function bestEffort(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn(
      `Could not ${what} (the change itself is saved): ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
