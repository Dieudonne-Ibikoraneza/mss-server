import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';

describe('keyset cursor', () => {
  it('round-trips a position exactly (millisecond precision)', () => {
    const at = new Date('2026-09-18T12:34:56.789Z');
    const decoded = decodeCursor(encodeCursor(at, 'abc-123'));
    expect(decoded.at.getTime()).toBe(at.getTime());
    expect(decoded.id).toBe('abc-123');
  });

  it('is URL-safe', () => {
    expect(encodeCursor(new Date(), 'a/b+c==')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['json without fields', Buffer.from('{}').toString('base64url')],
    ['a bad date', Buffer.from(JSON.stringify({ t: 'nope', id: 'x' })).toString('base64url')],
    [
      'an empty id',
      Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: '' })).toString('base64url'),
    ],
    [
      'a huge id',
      Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: 'x'.repeat(500) })).toString(
        'base64url',
      ),
    ],
    [
      'a non-string id',
      Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: 5 })).toString('base64url'),
    ],
  ])('rejects %s with a 400', (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });
});
