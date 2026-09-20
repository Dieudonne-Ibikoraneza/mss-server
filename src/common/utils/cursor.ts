import { badRequest } from '@/common/errors/app-error';

/**
 * Keyset ("seek") pagination position: the sort key of the last row a client
 * has seen — a timestamp plus the row's id as the tie-break. Unlike an offset
 * it neither skips nor repeats rows when new ones arrive mid-scroll, and
 * unlike a bare "id of the last row" cursor it still works if that row has
 * since been deleted or left the result set.
 */
export interface KeysetCursor {
  at: Date;
  id: string;
}

const MAX_ID_LENGTH = 100;

export const encodeCursor = (at: Date, id: string): string =>
  Buffer.from(JSON.stringify({ t: at.toISOString(), id })).toString('base64url');

/** Throws 400 for anything that isn't a cursor this module produced. */
export const decodeCursor = (cursor: string): KeysetCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    const at = typeof parsed.t === 'string' ? new Date(parsed.t) : null;
    if (
      !at ||
      Number.isNaN(at.getTime()) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0 ||
      parsed.id.length > MAX_ID_LENGTH
    ) {
      throw new Error('malformed');
    }
    return { at, id: parsed.id };
  } catch {
    throw badRequest('common.invalidCursor', 'Invalid cursor.');
  }
};
