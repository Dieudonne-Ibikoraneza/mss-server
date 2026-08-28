import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { QuotesService } from './quotes.service';
import { CreateQuoteRequestDto } from './dto/create-quote-request.dto';
import { UpdateQuoteStatusDto } from './dto/update-quote-status.dto';

@ApiTags('quotes')
@ApiBearerAuth()
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotesService: QuotesService) {}

  @ApiOperation({ summary: 'Request a quote' })
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateQuoteRequestDto) {
    return this.quotesService.create(userId, dto);
  }

  @ApiOperation({ summary: "List the current user's quote requests" })
  @Get('mine')
  findMine(@CurrentUser('id') userId: string) {
    return this.quotesService.findMine(userId);
  }

  @Roles(Role.ADMIN, Role.SALES_PERSON)
  @ApiOperation({ summary: 'List all quote requests (admin/sales)' })
  @Get()
  findAll() {
    return this.quotesService.findAll();
  }

  @Roles(Role.ADMIN, Role.SALES_PERSON)
  @ApiOperation({ summary: 'Update quote status (admin/sales)' })
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.quotesService.updateStatus(id, dto, user);
  }
}
