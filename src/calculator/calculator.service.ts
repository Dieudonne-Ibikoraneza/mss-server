import { Injectable } from '@nestjs/common';
import { badRequest, notFound } from '@/common/errors/app-error';
import { PrismaService } from '@/prisma/prisma.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { availableAreaSqmOf } from '@/common/utils/stock-status';
import { FloorPlanDto } from './dto/floor-plan.dto';

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

    const quantity = calculateTileQuantity(areaWithWastage, {
      tileAreaSqm: Number(product.collection.tileAreaSqm),
      boxCoverageSqm: Number(product.boxCoverageSqm),
      piecesPerBox: product.piecesPerBox,
    });

    // Stock is held in m²; convert to pieces here only to split this specific
    // request between what's on hand and what needs sourcing — never stored
    // that way. Other customers' unpaid orders can be holding part of it
    // (`reservedAreaSqm`), so "from stock" here means "actually available to
    // buy right now", not just what's physically on the shelf.
    const tileAreaSqm = Number(product.collection.tileAreaSqm);
    const availableAreaSqm = availableAreaSqmOf(
      Number(product.quantityOnHandSqm),
      Number(product.reservedAreaSqm),
    );
    const availablePieces = Math.floor(availableAreaSqm / tileAreaSqm);
    const fromStockPieces = Math.min(availablePieces, quantity.totalPieces);
    const toSourcePieces = quantity.totalPieces - fromStockPieces;

    // Priced by area, not by the box — see `orders.service.ts#create`.
    const estimatedCost = quantity.purchasedArea * Number(product.price);

    // Only the qualitative outcome leaves the server here: this endpoint is
    // `@Public()`, and returning `fromStockPieces`/`toSourcePieces` would hand
    // any anonymous visitor the exact available-to-buy quantity (just request
    // an area past the shelf and read `fromStockPieces` back). The public
    // catalog deliberately caps stock visibility at `stockStatus`
    // (`canSeeExactStock`) — the calculator matches that.
    return {
      baseAreaSqm: baseArea,
      wastagePercent,
      requiredAreaSqm: areaWithWastage,
      quantity,
      stockSplit: {
        fullyAvailableFromStock: toSourcePieces === 0,
        partiallyAvailableFromStock: fromStockPieces > 0 && toSourcePieces > 0,
      },
      estimatedCost,
      currency: product.currency,
    };
  }
}
