import { Injectable } from '@nestjs/common';
import { badRequest, notFound } from '@/common/errors/app-error';
import { PrismaService } from '@/prisma/prisma.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { availableAreaSqmOf } from '@/common/utils/stock-status';
import { FloorPlanDto } from './dto/floor-plan.dto';
import { calculateBaseboard } from './baseboard-calculator';

@Injectable()
export class CalculatorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 3.8 Floor plan calculator: turns a room's dimensions into a material
   * quantity (with wastage allowance), splits the recommendation between
   * what is available from current stock and what would need to be
   * sourced separately, and estimates the total material cost.
   */
  async calculate(dto: FloorPlanDto) {
    const baseArea =
      dto.totalAreaSqm ?? (dto.length && dto.width ? dto.length * dto.width : undefined);
    if (!baseArea) {
      throw badRequest(
        'calculator.areaOrDimensionsRequired',
        'Provide either totalAreaSqm or both length and width.',
      );
    }

    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { collection: true },
    });
    if (!product) throw notFound('catalog.productNotFound', 'Product not found.');

    const wastagePercent = dto.wastagePercent ?? 10;
    const areaWithWastage = baseArea * (1 + wastagePercent / 100);

    const packaging = {
      tileAreaSqm: Number(product.collection.tileAreaSqm),
      boxCoverageSqm: Number(product.boxCoverageSqm),
      piecesPerBox: product.piecesPerBox,
    };
    const unitPrice = Number(product.price);
    const floorQuantity = calculateTileQuantity(areaWithWastage, packaging);
    let baseboard: ReturnType<typeof calculateBaseboard> | null = null;
    if (dto.baseboard) {
      const perimeterM =
        dto.baseboard.perimeterM ??
        (dto.length && dto.width && dto.totalAreaSqm === undefined
          ? 2 * (dto.length + dto.width)
          : undefined);
      if (!perimeterM) {
        throw badRequest(
          'calculator.baseboardPerimeterRequired',
          'Enter the room perimeter to calculate baseboards when using a total area.',
        );
      }
      baseboard = calculateBaseboard({
        size: product.collection.size,
        tileAreaSqm: packaging.tileAreaSqm,
        perimeterM,
        heightCm: dto.baseboard.heightCm,
        openingsWidthM: dto.baseboard.openingsWidthM ?? 0,
        cutWidthMm: dto.baseboard.cutWidthMm ?? 3,
        wastagePercent: dto.baseboard.wastagePercent ?? wastagePercent,
        unitPrice,
      });
    }
    // Each part reserves whole tiles. Pool those tiles into one packaging and
    // cart calculation for the selected product, without adding wastage twice.
    const totalPieces = floorQuantity.totalPieces + (baseboard?.totalTiles ?? 0);
    const combinedBoxes = Math.floor(totalPieces / packaging.piecesPerBox);
    const combinedPieces = totalPieces % packaging.piecesPerBox;
    const requiredAreaSqm =
      baseboard && baseboard.totalTiles > 0
        ? Math.round(
            (combinedBoxes * packaging.boxCoverageSqm + combinedPieces * packaging.tileAreaSqm) *
              1_000_000,
          ) / 1_000_000
        : areaWithWastage;
    const quantity =
      baseboard && baseboard.totalTiles > 0
        ? calculateTileQuantity(requiredAreaSqm, packaging)
        : floorQuantity;

    // Compare the actual area the cart will reserve, including any declared
    // box coverage. Other customers' holds reduce what's available to buy.
    const tileAreaSqm = Number(product.collection.tileAreaSqm);
    const availableAreaSqm = availableAreaSqmOf(
      Number(product.quantityOnHandSqm),
      Number(product.reservedAreaSqm),
    );
    const fullyAvailableFromStock =
      Math.round(quantity.purchasedArea * 1_000_000) <= Math.round(availableAreaSqm * 1_000_000);

    // Priced by area, not by the box — see `orders.service.ts#create`.
    const estimatedCost = quantity.purchasedArea * unitPrice;
    const floorCost = floorQuantity.purchasedArea * unitPrice;
    if (baseboard) {
      // Allocate the actual extra cost after pooling boxes, including any
      // difference between declared box coverage and summed tile areas.
      baseboard.purchasedAreaSqm =
        Math.round((quantity.purchasedArea - floorQuantity.purchasedArea) * 1_000_000) / 1_000_000;
      baseboard.estimatedCost = baseboard.purchasedAreaSqm * unitPrice;
    }

    // Only the qualitative outcome leaves the server here: this endpoint is
    // `@Public()`, and returning `fromStockPieces`/`toSourcePieces` would hand
    // any anonymous visitor the exact available-to-buy quantity (just request
    // an area past the shelf and read `fromStockPieces` back). The public
    // catalog deliberately caps stock visibility at `stockStatus`
    // (`canSeeExactStock`) — the calculator matches that.
    return {
      baseAreaSqm: baseArea,
      wastagePercent,
      requiredAreaSqm,
      floor: {
        requiredAreaSqm: areaWithWastage,
        quantity: floorQuantity,
        estimatedCost: floorCost,
      },
      baseboard,
      quantity,
      stockSplit: {
        fullyAvailableFromStock,
        partiallyAvailableFromStock: !fullyAvailableFromStock && availableAreaSqm >= tileAreaSqm,
      },
      estimatedCost,
      currency: product.currency,
    };
  }
}
