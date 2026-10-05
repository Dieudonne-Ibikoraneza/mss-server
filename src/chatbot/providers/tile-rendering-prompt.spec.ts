import { tileDimensionsMetres, tileInstallationInstructions } from './tile-rendering-prompt';

describe('physical tile repeat instructions', () => {
  const tile = { name: 'Diagonal marble', description: 'Printed diagonal bands', size: '30×30cm' };

  it.each([
    ['30×30cm', [0.3, 0.3]],
    ['25 x 40 cm', [0.25, 0.4]],
    ['300mm × 600mm', [0.3, 0.6]],
    ['0.3m x 0.6m', [0.3, 0.6]],
    ['30,5×40cm', [0.305, 0.4]],
  ])('reads catalog dimensions %s without inferring them from an image', (size, expected) => {
    expect(tileDimensionsMetres(size)).toEqual(expected);
  });

  it('anchors a 30 cm floor to real repeat counts and the customer room dimensions', () => {
    const prompt = tileInstallationInstructions(tile, 'floor tile', 'Living room, 6 m x 4 m.');
    expect(prompt).toContain('0.3 m by 0.3 m');
    expect(prompt).toContain('a 3 m span contains 10 tile widths');
    expect(prompt).toContain('11.11 individual tiles per square metre');
    expect(prompt).toContain('20 by 13.33 tile modules');
    expect(prompt).toContain('267 tile-area equivalents before waste');
    expect(prompt).toContain('artwork, not separate long planks');
  });

  it('uses the saved half-turn arrangement rather than inventing a plank layout', () => {
    const prompt = tileInstallationInstructions(
      { ...tile, visualizerPattern: 'TWO_TURN' },
      'floor tile',
    );
    expect(prompt).toContain('180-degree-rotated copy in a checkerboard');
    expect(prompt).toContain('Do not use 90-degree turns');
  });

  it('keeps four-turn motif groups at four physical tiles and honors the selected corner', () => {
    const prompt = tileInstallationInstructions(
      { ...tile, visualizerPattern: 'QUARTER_TURN', visualizerPatternCorner: 'BOTTOM_LEFT' },
      'floor tile',
    );
    expect(prompt).toContain('bottom-left corner meets at the center');
    expect(prompt).toContain('Each group measures 0.6 m by 0.6 m');
    expect(prompt).toContain('never one enlarged tile');
  });

  it('avoids distorting rectangular tiles with quarter-turns, matching the 3D renderer', () => {
    const prompt = tileInstallationInstructions(
      { ...tile, size: '25×40cm', visualizerPattern: 'QUARTER_TURN' },
      'wall tile',
    );
    expect(prompt).toContain('TWO-TURN');
    expect(prompt).not.toContain('FOUR-TURN');
    expect(prompt).toContain('0.25 m by 0.4 m');
    expect(prompt).not.toContain("customer's");
  });

  it('does not invent dimensions for unknown or invalid size labels', () => {
    for (const size of ['unknown', '0×30cm', '30×0cm'])
      expect(tileDimensionsMetres(size)).toBeNull();
    const prompt = tileInstallationInstructions(
      { ...tile, size: 'unknown', tileAreaSqm: 0.09 },
      'floor tile',
    );
    expect(prompt).toContain('11.11 individual tiles per square metre');
    expect(prompt).not.toContain('0.3 m by 0.3 m');
  });

  it('retains a straight repeating artwork for plain and subtle-pattern products', () => {
    const prompt = tileInstallationInstructions(
      { ...tile, visualizerPattern: 'STRAIGHT' },
      'floor tile',
    );
    expect(prompt).toContain('same orientation in every cell');
    expect(prompt).toContain('no random rotation or mirroring');
    expect(prompt).toContain('2–3 mm');
  });
});
