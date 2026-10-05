import { Language, PrismaClient, RoomType } from '@prisma/client';
import { v5 as uuidv5 } from 'uuid';

type PreferenceQuestion = {
  key: string;
  text: string;
  roomTypes: RoomType[];
};

export const preferenceQuestions: PreferenceQuestion[] = [
  { key: 'room', text: 'Which room are you designing?', roomTypes: [] },
  {
    key: 'surfaces',
    text: 'Which surfaces are you tiling: floor, walls, or both? Describe any feature wall or backsplash you want.',
    roomTypes: [],
  },
  {
    key: 'area',
    text: 'What area needs tiling, in square metres? Give the floor area and wall area separately if both need tiles; include room dimensions if you know them.',
    roomTypes: [],
  },
  {
    key: 'budget',
    text: 'What is your tile budget per square metre in RWF, excluding installation? Give a preferred range and a maximum, or say flexible.',
    roomTypes: [],
  },
  {
    key: 'palette',
    text: 'Which colors should dominate your tiles, and which colors should we avoid? For example: cream, ivory, beige, smoky grey, warm brown, or bold accents.',
    roomTypes: [],
  },
  {
    key: 'look',
    text: 'Which tile look do you prefer: marble, wood, concrete, natural stone, geometric, or plain? Describe whether the pattern should be subtle or a bold feature.',
    roomTypes: [],
  },
  {
    key: 'finish',
    text: 'Which finish do you prefer: matte, satin, or glossy? Tell us whether avoiding glare or having a polished appearance matters more, or say no preference.',
    roomTypes: [],
  },
  {
    key: 'format',
    text: 'Which tile dimensions do you prefer: 30x30 cm, 40x40 cm, 60x60 cm, rectangular, or another format? Say flexible if you want us to suggest a format.',
    roomTypes: [],
  },
  {
    key: 'existing-colors',
    text: 'What wall and ceiling colors will remain in the room? Mention any existing tiles or finishes the new tiles must coordinate with.',
    roomTypes: [],
  },
  {
    key: 'lighting',
    text: 'How much natural light does the room receive: little, moderate, or plenty? Is the artificial lighting mainly warm or cool?',
    roomTypes: [],
  },
  {
    key: 'daily-use',
    text: 'How busy is the space, and who uses it: adults, children, pets, or frequent visitors? Describe your priorities for everyday cleaning and use.',
    roomTypes: [],
  },
  {
    key: 'living-furniture',
    text: 'What colors and materials are your sofa, chairs, and tables? Mention the dominant furniture color and any wood, glass, or metal finishes.',
    roomTypes: [RoomType.LIVING_ROOM],
  },
  {
    key: 'living-soft-finishes',
    text: 'What colors and patterns are your curtains or blinds, rugs, and interior doors? Should the floor blend quietly with them or be the main design feature?',
    roomTypes: [RoomType.LIVING_ROOM],
  },
  {
    key: 'bedroom-furniture',
    text: 'What colors and materials are your bed, wardrobes, bedding, and curtains? Which of these existing finishes should the tiles complement?',
    roomTypes: [RoomType.BEDROOM],
  },
  {
    key: 'bedroom-comfort',
    text: 'For the bedroom, what matters most: a calm look, a warm appearance, easy cleaning, or another priority? Do you plan to use rugs over the tiled floor?',
    roomTypes: [RoomType.BEDROOM],
  },
  {
    key: 'kitchen-finishes',
    text: 'What colors and finishes are your kitchen cabinets, worktops, and appliances? Do you want the tiles to match them or provide a contrasting accent?',
    roomTypes: [RoomType.KITCHEN],
  },
  {
    key: 'kitchen-coverage',
    text: 'Which kitchen areas need tiles: the floor, backsplash, full walls, or a combination? Describe areas near the sink or cooker and any cleaning concerns.',
    roomTypes: [RoomType.KITCHEN],
  },
  {
    key: 'bathroom-wet-areas',
    text: 'Which bathroom surfaces need tiles, including the shower floor and walls? Describe where water reaches the floor and any concerns about grip when wet.',
    roomTypes: [RoomType.BATHROOM],
  },
  {
    key: 'bathroom-coverage',
    text: 'Should bathroom wall tiles cover the full height or only part of the wall? Describe your preferred floor-and-wall color pairing and any accent area.',
    roomTypes: [RoomType.BATHROOM],
  },
];

// Only retire the old starter set and the short questions it was replaced with.
// Other admin-authored questions are preserved.
const retiredQuestionTexts = [
  'What is your primary goal for using this space today?',
  'What is the approximate size of the space?',
  'What is the primary wall paint color?',
  'What is the dominant color of your large furniture?',
  'What style are the interior doors?',
  'Are the tables predominantly wooden or glass?',
  'What is the style of your window curtains or blinds?',
  'What material are the accent chairs?',
  "what is the room size for the room you're building? (in sqm)",
  'What is the wall paint color of the room!',
  'What is the color, clothing and style of the indoor curtains?',
  'What is the color of the most dominant furniture in the room?',
  'What is the type and the color of the roof of the room',
  'What is the color style that should be dominant in the bathroom?',
];

/** A narrow, repeatable seed: no products, accounts, or other settings are changed. */
export async function seedPreferenceQuestions(prisma: PrismaClient) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.profilingQuestion.findMany({ where: { language: Language.EN } });
      let created = 0;
      let updated = 0;
      for (const [position, question] of preferenceQuestions.entries()) {
        const stableId = uuidv5(`magnificat:tile-preferences:v1:${question.key}`, uuidv5.URL);
        const match = existing.find((row) => row.id === stableId || row.text === question.text);
        const data = {
          text: question.text,
          roomTypes: question.roomTypes,
          position,
          isRequired: true,
          isActive: true,
          language: Language.EN,
        };
        await tx.profilingQuestion.upsert({
          where: { id: match?.id ?? stableId },
          create: { id: stableId, ...data },
          update: data,
        });
        if (match) updated++;
        else created++;
      }
      const retired = await tx.profilingQuestion.updateMany({
        where: { language: Language.EN, isActive: true, text: { in: retiredQuestionTexts } },
        data: { isActive: false },
      });
      return { created, updated, retired: retired.count, configured: preferenceQuestions.length };
    },
    { timeout: 15_000 },
  );
}
