import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { QueryAnalyticsDto, QueryAnalyticsTableDto } from './dto/query-analytics.dto';

/** Doc 3.9 dashboards. Read-only, and limited to the roles allowed to see business data. */
const ANALYTICS_ROLES = [Role.DATA_ANALYST, Role.ADMIN] as const;

@ApiTags('analytics')
@ApiBearerAuth()
@Roles(...ANALYTICS_ROLES)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @ApiOperation({ summary: 'Cross-dashboard KPI overview' })
  @Get('overview')
  overview(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.overview(query.period);
  }

  @ApiOperation({ summary: 'Customer profile analytics' })
  @Get('customers')
  customers(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.customerAnalytics(query.period);
  }

  @ApiOperation({ summary: 'Tile interaction leaderboards' })
  @Get('tiles')
  tiles() {
    return this.analyticsService.tileInteractionAnalytics();
  }

  @ApiOperation({ summary: 'Per-tile interaction table with selection and conversion rates' })
  @Get('tiles/table')
  tilesTable(@Query() query: QueryAnalyticsTableDto) {
    return this.analyticsService.tilePerformanceTable(query);
  }

  @ApiOperation({ summary: 'Selection rate and purchase conversion for one tile' })
  @Get('tiles/:productId/rates')
  tileRates(@Param('productId') productId: string) {
    return this.analyticsService.tileRates(productId);
  }

  @ApiOperation({ summary: 'Customer journey funnel with per-stage drop-off' })
  @Get('journey')
  journey(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.journeyAnalytics(query.period);
  }

  @ApiOperation({ summary: 'Sales analytics: totals, trend, best sellers, project types' })
  @Get('sales')
  sales(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.salesAnalytics(query.period);
  }

  @ApiOperation({ summary: 'AI recommendation performance' })
  @Get('ai-recommendations')
  recommendations(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.recommendationPerformance(query.period);
  }

  @ApiOperation({ summary: 'Per-tile AI recommendation table' })
  @Get('ai-recommendations/table')
  recommendationsTable(@Query() query: QueryAnalyticsTableDto) {
    return this.analyticsService.recommendationTable(query);
  }

  @ApiOperation({ summary: 'How customers discovered the business' })
  @Get('marketing')
  marketing(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.marketingAnalysis(query);
  }
}
