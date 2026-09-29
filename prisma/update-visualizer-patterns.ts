import { PrismaClient, VisualizerTilePattern, VisualizerTileCorner } from '@prisma/client';

const prisma = new PrismaClient();

const tilePatterns: Record<string, VisualizerTilePattern> = {
  'Slate Grey Cobblestone Fan Floor': VisualizerTilePattern.QUARTER_TURN,
  'Twyford W42358 Grey Multi-Plank Series': VisualizerTilePattern.TWO_TURN,
  'Twyford W42502 Rustic Cobblestone Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford WQ36014G Olive-Sage Ledger Stone Series': VisualizerTilePattern.TWO_TURN,
  'Twyford WQ36015G Dark Grey Ledger Stone Series Tile': VisualizerTilePattern.TWO_TURN,
  'Twyford WQ36015G Dark Grey Split Stone Series': VisualizerTilePattern.TWO_TURN,
  'Twyford WQ36016G Ivory Quartz Ledger Stone Series Tile': VisualizerTilePattern.TWO_TURN,
  'Twyford WQ36016G Ivory Quartz Ledger Stone Series': VisualizerTilePattern.TWO_TURN,
  'Twyford WQ36017I Bronze-Bronze Split Stone Series Tile': VisualizerTilePattern.TWO_TURN,
  'Twyford PMC824354 Dark Chocolate Metro Series Wall Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford PMC824354AJ White Metro Series': VisualizerTilePattern.STRAIGHT,
  'Twyford PMCP24104J Wall Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford PMCP24158T Wall Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford PMCP42026T Wall Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FGP33756J Floor Tile': VisualizerTilePattern.QUARTER_TURN,
  'Twyford FHP33605J Floor Tile': VisualizerTilePattern.QUARTER_TURN,
  'Twyford FHP33780J Floor Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP33785J Floor Tile': VisualizerTilePattern.QUARTER_TURN,
  'Twyford YME33001J Floor Tile': VisualizerTilePattern.QUARTER_TURN,
  'Twyford W36271T Linear Grey Bamboo-Stone Series': VisualizerTilePattern.TWO_TURN,
  'Twyford W36501T Beige Concrete-Stone Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford W36502T Light Concrete Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford W36581T Beige Swirl-Stone Decorative Series TIle': VisualizerTilePattern.TWO_TURN,
  '3D Cube Stone Grey': VisualizerTilePattern.QUARTER_TURN,
  'Ardesia Grey': VisualizerTilePattern.STRAIGHT,
  'Calacatta White': VisualizerTilePattern.STRAIGHT,
  'Crema Marfil': VisualizerTilePattern.STRAIGHT,
  'Crosswood Beige': VisualizerTilePattern.QUARTER_TURN,
  'Diagonal Timber Mix': VisualizerTilePattern.TWO_TURN,
  'Linear Ash Grey': VisualizerTilePattern.TWO_TURN,
  'Linear Walnut Beige': VisualizerTilePattern.TWO_TURN,
  'Linear Walnut Grey': VisualizerTilePattern.TWO_TURN,
  'Malaga Chevron Beech': VisualizerTilePattern.TWO_TURN,
  'Mocha Plain Matte': VisualizerTilePattern.STRAIGHT,
  'Moon Quartz II': VisualizerTilePattern.STRAIGHT,
  'Nordic Ash': VisualizerTilePattern.TWO_TURN,
  'Nordic Oak Light': VisualizerTilePattern.TWO_TURN,
  'Onyx Charcoal Grey': VisualizerTilePattern.STRAIGHT,
  'Onyx Silver Light': VisualizerTilePattern.STRAIGHT,
  'Pixel Grid Deco Grey': VisualizerTilePattern.QUARTER_TURN,
  'Royal Calacatta Gold': VisualizerTilePattern.STRAIGHT,
  'Royal Damask Beige': VisualizerTilePattern.QUARTER_TURN,
  'Royal Statuario Gold': VisualizerTilePattern.STRAIGHT,
  'Sandstone Grey Granular': VisualizerTilePattern.STRAIGHT,
  'Siberian Ice': VisualizerTilePattern.STRAIGHT,
  'Spider Web White': VisualizerTilePattern.QUARTER_TURN,
  'Twyford BlE44021T tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FGE44761T Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FGP44007 Floor Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford GFT44063T tile': VisualizerTilePattern.QUARTER_TURN,
  'Twyford MR44017Z Floor Tile': VisualizerTilePattern.STRAIGHT,
  'Calacatta Luxe Polished': VisualizerTilePattern.STRAIGHT,
  'Diamond Beige Polished': VisualizerTilePattern.STRAIGHT,
  'FHP Oak Matte Wood Series': VisualizerTilePattern.TWO_TURN,
  'Glacier Jade White': VisualizerTilePattern.STRAIGHT,
  'Malaga Parquet Oak': VisualizerTilePattern.TWO_TURN,
  'Onyx Beige': VisualizerTilePattern.STRAIGHT,
  'Royal Amber Walnut Polished': VisualizerTilePattern.TWO_TURN,
  'Royal Emperador Grey Polished': VisualizerTilePattern.STRAIGHT,
  'Royal Pearl Grey Polished': VisualizerTilePattern.STRAIGHT,
  'Sandstone Grey Matte': VisualizerTilePattern.STRAIGHT,
  'Silver Rock Matte': VisualizerTilePattern.STRAIGHT,
  'Statuario Classic Polished': VisualizerTilePattern.STRAIGHT,
  'Super Beige Polished': VisualizerTilePattern.STRAIGHT,
  'Super Black Polished': VisualizerTilePattern.STRAIGHT,
  'Super Ivory Polished': VisualizerTilePattern.STRAIGHT,
  'Super White Polished': VisualizerTilePattern.STRAIGHT,
  'Travertine Crema Polished': VisualizerTilePattern.STRAIGHT,
  'Twford YMD55796T Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford 60G004T Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP55041T Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford YMP55285T Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford 60G011T Grey Emperador Marble Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP66051T Concrete Matt Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP66052T Sand-Concrete Matt Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP66053T Sandy Terrazzo-Stone Matt Series Tile': VisualizerTilePattern.STRAIGHT,
  'Twyford FHP66501T Wood Plank Matte Series Tile': VisualizerTilePattern.TWO_TURN,
};

// These are import/audit mappings only. Runtime rendering uses stored product
// fields, so names and SKUs can change without changing the tile arrangement.
const tileCorners: Record<string, VisualizerTileCorner> = {
  'Slate Grey Cobblestone Fan Floor': VisualizerTileCorner.BOTTOM_RIGHT,
};

const normalize = (value: string) =>
  value
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/%20/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();

const skuOf = (tileName: string) =>
  tileName.match(/\b(?:Twyford|Twford)\s+([A-Z0-9]+)/i)?.[1].toLowerCase();

const patternEntries = Object.entries(tilePatterns).map(([tileName, pattern]) => ({
  tileName,
  normalizedName: normalize(tileName),
  sku: skuOf(tileName),
  pattern,
}));

const matchingPattern = (product: {
  sku: string;
  name: string;
  image: string;
  collection: { title: string; size: string };
}) => {
  const productSku = product.sku.toLowerCase();
  const productName = normalize(product.name);
  const imageName = normalize(product.image.split('/').pop() ?? product.image);
  const haystack = normalize(
    [
      product.sku,
      product.name,
      product.image,
      product.collection.title,
      product.collection.size,
    ].join(' '),
  );

  return patternEntries.find((entry) => {
    if (entry.sku && productSku === entry.sku) return true;
    if (imageName === entry.normalizedName) return true;
    if (productName === entry.normalizedName) return true;
    return haystack.includes(entry.normalizedName);
  });
};

const inferredPattern = (product: {
  sku: string;
  name: string;
  image: string;
  collection: { title: string; size: string };
}): VisualizerTilePattern => {
  const haystack = normalize(
    [
      product.sku,
      product.name,
      product.image,
      product.collection.title,
      product.collection.size,
    ].join(' '),
  );
  if (
    [
      'bamboo',
      'herringbone',
      'ledger',
      'multi plank',
      'oak',
      'parquet',
      'plank',
      'split stone',
      'wood',
    ].some((term) => haystack.includes(term))
  ) {
    return VisualizerTilePattern.TWO_TURN;
  }
  return VisualizerTilePattern.STRAIGHT;
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const products = await prisma.product.findMany({
    select: {
      id: true,
      sku: true,
      name: true,
      image: true,
      visualizerPattern: true,
      visualizerPatternCorner: true,
      collection: { select: { title: true, size: true } },
    },
    orderBy: { name: 'asc' },
  });

  const updates = products.map((product) => {
    const match = matchingPattern(product);
    return {
      product,
      tileName: match?.tileName ?? 'inferred from product metadata',
      pattern: match?.pattern ?? inferredPattern(product),
      corner: match
        ? (tileCorners[match.tileName] ?? product.visualizerPatternCorner)
        : product.visualizerPatternCorner,
    };
  });

  for (const { product, pattern, corner, tileName } of updates) {
    const changed =
      product.visualizerPattern !== pattern || product.visualizerPatternCorner !== corner;
    const marker = !changed ? 'unchanged' : dryRun ? 'would update' : 'updated';
    console.log(
      `${marker}: ${product.sku} | ${product.name} -> ${pattern}, ${corner} (${tileName})`,
    );
    if (!dryRun && changed) {
      await prisma.product.update({
        where: { id: product.id },
        data: { visualizerPattern: pattern, visualizerPatternCorner: corner },
      });
    }
  }

  console.log(`${dryRun ? 'Dry run complete' : 'Update complete'}: ${updates.length} product(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
