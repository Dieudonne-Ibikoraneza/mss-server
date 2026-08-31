import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { ReportsService } from './reports.service';
import { QueryMovementsDto } from './dto/query-movements.dto';
import { QueryReportDto } from './dto/query-report.dto';

/**
 * Stock reporting for the warehouse side of the business (doc 3.10, 3.11) —
 * movements, low stock, and the fulfilment queue. The rest of the stock
 * reports page (sales overview, AI performance, repeat purchase rate,
 * conversion journey) lives under `/analytics/*`, which this same set of
 * roles can also reach — see `analytics.controller.ts`.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Roles(Role.STOCK_MANAGER, Role.ADMIN, Role.DATA_ANALYST)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @ApiOperation({ summary: 'Stock movement totals and trend for a period' })
  @Get('stock/summary')
  stockSummary(@Query() query: QueryReportDto) {
    return this.reportsService.stockSummary(query.period);
  }

  @ApiOperation({ summary: 'Paginated stock movement feed (inbound/outbound/adjustment)' })
  @Get('stock/movements')
  stockMovements(@Query() query: QueryMovementsDto) {
    return this.reportsService.stockMovements(query);
  }

  @ApiOperation({ summary: 'Products at or below their low-stock threshold' })
  @Get('stock/low-stock')
  lowStock() {
    return this.reportsService.lowStock();
  }

  @ApiOperation({ summary: 'Orders still awaiting fulfilment, grouped by status' })
  @Get('stock/fulfillment-queue')
  fulfillmentQueue() {
    return this.reportsService.fulfillmentQueue();
  }
}
