import { ConfigService } from '@nestjs/config';
import { StorageService } from '@/storage/storage.service';
import { callGeminiImageModel } from './gemini-image-client';
import { GeminiImageProvider } from './gemini-image.provider';
import { GeminiRoomTileProvider } from './gemini-room-tile.provider';
import { createTileRepeatReference } from './tile-repeat-reference';

jest.mock('./gemini-image-client', () => ({ callGeminiImageModel: jest.fn() }));
jest.mock('./tile-repeat-reference', () => ({
  ...jest.requireActual<typeof import('./tile-repeat-reference')>('./tile-repeat-reference'),
  createTileRepeatReference: jest.fn(),
}));

describe('Gemini tile image requests', () => {
  const call = jest.mocked(callGeminiImageModel);
  const floorReference = { mimeType: 'image/png', data: 'floor-reference-bytes' };
  const wallReference = { mimeType: 'image/png', data: 'wall-reference-bytes' };
  const roomReference = { mimeType: 'image/jpeg', data: 'original-room-bytes' };
  const floorProof = { mimeType: 'image/png', data: 'floor-proof-bytes' };
  const wallProof = { mimeType: 'image/png', data: 'wall-proof-bytes' };
  const createProof = jest.mocked(createTileRepeatReference);
  const product = {
    name: 'Small patterned tile',
    description: 'Diagonal bands',
    collection: 'Floor tiles',
    size: '30×30cm',
    imageUrl: 'floor.png',
    suitableFor: 'FLOOR',
    tileAreaSqm: 0.09,
    visualizerPattern: 'TWO_TURN',
    visualizerPatternCorner: 'TOP_RIGHT',
  } as const;
  const config = {
    get: (key: string) => (key.endsWith('apiKey') ? 'test-key' : 'test-model'),
  } as unknown as ConfigService;
  const download = jest.fn();
  const storage = { downloadProductReference: download } as unknown as StorageService;

  const sentPrompt = () => {
    const parts = call.mock.calls.at(-1)?.[3];
    if (!parts) throw new Error('No image request sent');
    return parts.flatMap((part) => ('text' in part ? [part.text] : [])).join('\n');
  };

  beforeEach(() => {
    jest.clearAllMocks();
    call.mockResolvedValue({ data: 'generated-image', mimeType: 'image/png' });
    download.mockResolvedValue(floorReference);
    createProof.mockImplementation((reference) =>
      Promise.resolve(reference.data === wallReference.data ? wallProof : floorProof),
    );
  });

  it('sends the catalog reference, correct scale and saved layout for a floor recommendation', async () => {
    await new GeminiImageProvider(config, storage).generate({
      customerBrief: 'Living room, 6 m x 4 m.',
      product,
    });
    expect(sentPrompt()).toContain('FLOOR-only');
    expect(sentPrompt()).toContain('a 3 m span contains 10 tile widths');
    expect(sentPrompt()).toContain('180-degree-rotated copy');
    expect(call.mock.calls[0][3][1]).toEqual({ inlineData: floorReference });
    expect(call.mock.calls[0][3][2]).toEqual({ inlineData: floorProof });
    expect(sentPrompt()).toContain('8 individual tiles across and 8 down');
    expect(sentPrompt()).toContain('2.4 m by 2.4 m');
    expect(createProof).toHaveBeenCalledWith(floorReference, product);
  });

  it('keeps separate references, dimensions and layouts for paired kitchen materials', async () => {
    download.mockResolvedValueOnce(floorReference).mockResolvedValueOnce(wallReference);
    await new GeminiImageProvider(config, storage).generate({
      customerBrief: 'Kitchen, floor and backsplash.',
      roomType: 'KITCHEN',
      product,
      wallProduct: {
        ...product,
        name: 'Wall tile',
        size: '25×40cm',
        imageUrl: 'wall.png',
        suitableFor: 'WALL',
        visualizerPattern: 'STRAIGHT',
      },
    });
    const prompt = sentPrompt();
    expect(prompt).toContain('0.3 m by 0.3 m');
    expect(prompt).toContain('0.25 m by 0.4 m');
    expect(prompt).toContain('kitchen backsplash');
    expect(prompt).toContain('Never swap the materials');
    expect(call.mock.calls[0][3].slice(1)).toEqual([
      { inlineData: floorReference },
      { inlineData: wallReference },
      { inlineData: floorProof },
      { inlineData: wallProof },
    ]);
    expect(prompt).toContain('The FOURTH attached image (wall installation proof)');
    expect(prompt).toContain('2 m by 3.2 m');
  });

  it('does not fabricate a paired material whose reference cannot be downloaded', async () => {
    download.mockResolvedValueOnce(floorReference).mockResolvedValueOnce(null);
    expect(
      await new GeminiImageProvider(config, storage).generate({
        customerBrief: 'Bathroom',
        product,
        wallProduct: { ...product, imageUrl: 'missing.png' },
      }),
    ).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps a wall-only recommendation off the floor', async () => {
    await new GeminiImageProvider(config, storage).generate({
      customerBrief: 'Living room feature wall',
      product: { ...product, suitableFor: 'WALL' },
    });
    expect(sentPrompt()).toContain('Do not apply it to the floor');
  });

  it('uses the same repetition constraints for uploaded-room edits without changing the camera or rugs', async () => {
    await new GeminiRoomTileProvider(config).generate({
      roomImage: roomReference,
      tileImage: floorReference,
      product,
    });
    expect(sentPrompt()).toContain('a 3 m span contains 10 tile widths');
    expect(sentPrompt()).toContain('180-degree-rotated copy');
    expect(sentPrompt()).toContain(
      'Keep furniture, rugs, walls, windows, doors, ceiling, and their positions unchanged',
    );
    expect(sentPrompt()).toContain('do not paint over those objects or change the camera');
    expect(sentPrompt()).not.toContain('Use a room-scale camera view');
    expect(call.mock.calls[0][3].slice(1)).toEqual([
      { inlineData: roomReference },
      { inlineData: floorReference },
      { inlineData: floorProof },
    ]);
  });

  it('uses the original photograph if an optional installation proof cannot be created', async () => {
    createProof.mockResolvedValue(null);
    await new GeminiImageProvider(config, storage).generate({
      customerBrief: 'Living room',
      product,
    });
    expect(call.mock.calls[0][3].slice(1)).toEqual([{ inlineData: floorReference }]);
    expect(sentPrompt()).not.toContain('INSTALLATION PROOF');
  });
});
