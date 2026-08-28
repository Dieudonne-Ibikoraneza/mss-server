import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
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
      throw new BadRequestException('Provide either totalAreaSqm or both length and width.');
    }

    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { inventory: true, collection: true },
    });
    if (!product) throw new NotFoundException('Product not found.');

    const wastagePercent = dto.wastagePercent ?? 10;
    const areaWithWastage = baseArea * (1 + wastagePercent / 100);

    const quantity = calculateTileQuantity(areaWithWastage, {
      tileAreaSqm: Number(product.collection.tileAreaSqm),
      boxCoverageSqm: Number(product.boxCoverageSqm),
      piecesPerBox: product.piecesPerBox,
    });

    const available = Math.max(
      0,
      (product.inventory?.quantityOnHand ?? 0) - (product.inventory?.reservedQuantity ?? 0),
    );
    const fromStockPieces = Math.min(available, quantity.totalPieces);
    const toSourcePieces = quantity.totalPieces - fromStockPieces;

    const unitPricePerPiece = Number(product.price) / product.piecesPerBox;
    const estimatedCost = quantity.totalPieces * unitPricePerPiece;

    return {
      baseAreaSqm: baseArea,
      wastagePercent,
      requiredAreaSqm: areaWithWastage,
      quantity,
      stockSplit: {
        fromStockPieces,
        toSourcePieces,
        fullyAvailableFromStock: toSourcePieces === 0,
      },
      estimatedCost,
      currency: product.currency,
    };
  }
}
