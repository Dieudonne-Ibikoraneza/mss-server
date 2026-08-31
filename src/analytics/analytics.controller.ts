import { Controller, Get, Param, ParseEnumPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JourneyStage, Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { QueryAnalyticsDto } from './dto/query-analytics.dto';
import { QueryTilesDto } from './dto/query-tiles.dto';

/**
 * Doc 3.9 dashboards, structured around four domains — Customers, Sales,
 * Tiles (incl. AI recommendation performance, since recs are about tiles),
 * and Journey — plus a cross-domain `overview` for the landing screen.
 * Every route returns the same full shape to whichever role can reach it —
 * there's no per-viewer trimming here.
 *
 * `ADMIN`/`DATA_ANALYST`/`STOCK_MANAGER` reach all six routes.
 * `SALES_PERSON` is granted `overview`/`sales` only (their own Overview and
 * Sales screens), via a per-method `@Roles` override — customer/tile/journey
 * analytics stay outside their remit.
 */
const ANALYTICS_ROLES = [Role.ADMIN, Role.DATA_ANALYST, Role.STOCK_MANAGER] as const;
const SALES_OWN_SCREEN_ROLES = [...ANALYTICS_ROLES, Role.SALES_PERSON] as const;

@ApiTags('analytics')
@ApiBearerAuth()
@Roles(...ANALYTICS_ROLES)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Roles(...SALES_OWN_SCREEN_ROLES)
  @ApiOperation({
    summary: 'Cross-dashboard KPI overview',
    description: 'Also reachable by SALES_PERSON, for their own Overview screen.',
  })
  @Get('overview')
  overview(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.overview(query.period);
  }

  @ApiOperation({
    summary: 'Customer Analytics: totals, acquisition channels, project types, new-vs-repeat trend',
  })
  @Get('customers')
  customers(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.customers(query.period);
  }

  @Roles(...SALES_OWN_SCREEN_ROLES)
  @ApiOperation({
    summary: 'Sales Analytics: period totals, % change vs prior period, breakdowns, best sellers',
    description: 'Also reachable by SALES_PERSON, for their own Sales screen.',
  })
  @Get('sales')
  sales(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.sales(query.period);
  }

  @ApiOperation({
    summary: 'Tile Analytics: interaction leaderboards + per-tile table, one period-scoped call',
  })
  @Get('tiles')
  tiles(@Query() query: QueryTilesDto) {
    return this.analyticsService.tiles(query);
  }

  // Must be registered before `tiles/:productId` below — otherwise Nest's
  // route matching would capture the literal segment "recommendations" as
  // that route's `:productId` param instead of reaching this one.
  @ApiOperation({
    summary: 'AI recommendation performance: summary + per-tile table, one period-scoped call',
  })
  @Get('tiles/recommendations')
  tileRecommendations(@Query() query: QueryTilesDto) {
    return this.analyticsService.tileRecommendations(query);
  }

  @ApiOperation({ summary: 'Selection rate and purchase conversion for one tile' })
  @Get('tiles/:productId')
  tileDetail(@Param('productId') productId: string) {
    return this.analyticsService.tileRates(productId);
  }

  @ApiOperation({ summary: 'Customer journey funnel with per-stage drop-off' })
  @Get('journey')
  journey(@Query() query: QueryAnalyticsDto) {
    return this.analyticsService.journeyAnalytics(query.period);
  }

  @ApiOperation({
    summary: 'Drill down on one journey stage: who reached it and what they did there',
    description:
      'The users who reached this stage (with their profile, where known) plus the concrete ' +
      'action behind it — e.g. for SAVED_DESIGN, the actual room designs they saved.',
  })
  @Get('journey/:stage')
  journeyStageDetail(
    @Param('stage', new ParseEnumPipe(JourneyStage)) stage: JourneyStage,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analyticsService.journeyStageDetail(stage, query.period);
  }
}
