import { requestsNewRecommendations } from './chatbot.service';

describe('chatbot recommendation intent', () => {
  it.each([
    'What tiles are best for a modern kitchen?',
    'Please recommend the 3 best tiles.',
    'Show me some different options for the bathroom.',
    'I am looking for tiles for a modern bedroom.',
    'Yeah, you can bring these recommendations.',
    'That is enough, can you provide the recommendations?',
    'Can you get me those 3 perfect recommendations?',
    'I need premium large-format slabs for a grand living room.',
  ])('allows a fresh recommendation for: %s', (message) => {
    expect(requestsNewRecommendations(message)).toBe(true);
  });

  it.each([
    'The above tiles that you recommended, are they durable, and can they be applied in places with children?',
    'How do I clean those tiles?',
    'Are these safe when wet?',
    'How much do they cost?',
    'Which of those three is the most durable?',
  ])('keeps a contextual follow-up text-only for: %s', (message) => {
    expect(requestsNewRecommendations(message)).toBe(false);
  });
});
