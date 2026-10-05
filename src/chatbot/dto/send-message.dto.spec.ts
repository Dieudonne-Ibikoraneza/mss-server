import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

describe('complete preference briefs', () => {
  const validateMessage = (content: string) =>
    validate(plainToInstance(SendMessageDto, { sessionId: 'test', content }));

  it('accepts a questionnaire beyond the single-answer composer limit', async () => {
    const content = `${'Question and answer. '.repeat(250)}Please recommend the 3 best tiles.`;
    expect(content.length).toBeGreaterThan(2000);
    expect(await validateMessage(content)).toHaveLength(0);
  });

  it('keeps a bounded maximum and rejects empty messages', async () => {
    expect(await validateMessage('A'.repeat(32_768))).toHaveLength(0);
    expect(await validateMessage('A'.repeat(32_769))).not.toHaveLength(0);
    expect(await validateMessage('')).not.toHaveLength(0);
  });
});
