import sharp from 'sharp';
import { createTileRepeatReference } from './tile-repeat-reference';
import type { TileRenderingSpec } from './tile-rendering-prompt';

describe('tile installation references', () => {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const product: TileRenderingSpec = {
    name: 'Patterned tile',
    description: null,
    size: '40×40cm',
    visualizerPattern: 'STRAIGHT',
    visualizerPatternCorner: 'TOP_RIGHT',
  };
  let reference: { mimeType: string; data: string };

  beforeAll(async () => {
    const pixels = Buffer.alloc(128 * 128 * 3);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const color = colors[(y >= 64 ? 2 : 0) + (x >= 64 ? 1 : 0)];
        pixels.set(color, (y * 128 + x) * 3);
      }
    }
    const source = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
      .png()
      .toBuffer();
    reference = { mimeType: 'image/png', data: source.toString('base64') };
  });

  async function render(overrides: Partial<TileRenderingSpec> = {}) {
    const image = await createTileRepeatReference(reference, { ...product, ...overrides });
    if (!image) throw new Error('Missing installation reference');
    const { data, info } = await sharp(Buffer.from(image.data, 'base64'))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      info,
      pixel: (x: number, y: number) => [
        ...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3),
      ],
    };
  }

  it('repeats the exact source artwork in 64 separate cells with thin grout', async () => {
    const { info, pixel } = await render();
    expect([info.width, info.height]).toEqual([1031, 1031]);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        const x = column * 129,
          y = row * 129;
        expect(pixel(x + 16, y + 16)).toEqual(colors[0]);
        expect(pixel(x + 112, y + 16)).toEqual(colors[1]);
        expect(pixel(x + 16, y + 112)).toEqual(colors[2]);
        expect(pixel(x + 112, y + 112)).toEqual(colors[3]);
      }
    }
    expect(pixel(128, 64)).toEqual([184, 180, 170]);
  });

  it('rotates whole tiles by 180 degrees in the two-turn checkerboard', async () => {
    const { pixel } = await render({ visualizerPattern: 'TWO_TURN' });
    expect(pixel(16, 16)).toEqual(colors[0]);
    expect(pixel(145, 16)).toEqual(colors[3]);
    expect(pixel(16, 145)).toEqual(colors[3]);
    expect(pixel(145, 145)).toEqual(colors[0]);
  });

  it.each([
    ['TOP_RIGHT', 1],
    ['BOTTOM_RIGHT', 3],
    ['BOTTOM_LEFT', 2],
    ['TOP_LEFT', 0],
  ] as const)(
    'places the saved %s artwork corner at every four-tile group center',
    async (corner, color) => {
      const { pixel } = await render({
        visualizerPattern: 'QUARTER_TURN',
        visualizerPatternCorner: corner,
      });
      for (const [x, y] of [
        [112, 112],
        [145, 112],
        [112, 145],
        [145, 145],
      ]) {
        expect(pixel(x, y)).toEqual(colors[color]);
      }
    },
  );

  it('keeps rectangular tile proportions and falls back to two-turn for rectangular quarter-turn tiles', async () => {
    const { info, pixel } = await render({ size: '25×40cm', visualizerPattern: 'QUARTER_TURN' });
    expect([info.width, info.height]).toEqual([647, 1031]);
    expect(pixel(16, 16)).toEqual(colors[0]);
    expect(pixel(97, 16)).toEqual(colors[3]);
  });

  it('omits the optional proof when dimensions or source raster are unavailable', async () => {
    expect(await createTileRepeatReference(reference, { ...product, size: 'Unknown' })).toBeNull();
    expect(
      await createTileRepeatReference({ mimeType: 'image/png', data: 'invalid' }, product),
    ).toBeNull();
  });
});
