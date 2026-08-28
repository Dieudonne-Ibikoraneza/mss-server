import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { CalculateQuantityDto } from './dto/calculate-quantity.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @ApiOperation({ summary: 'List/search products' })
  @Get()
  findAll(@Query() query: QueryProductsDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.productsService.findAll(query, user?.role);
  }

  @Public()
  @ApiOperation({ summary: 'Get a product by id' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.productsService.findOne(id, user?.role);
  }

  @Public()
  @ApiOperation({ summary: 'Calculate boxes/quantity needed for an area' })
  @Post('calculate-quantity')
  calculateQuantity(@Body() dto: CalculateQuantityDto) {
    return this.productsService.calculateQuantity(dto);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product (admin/stock manager)' })
  @Post()
  create(@Body() dto: CreateProductDto, @CurrentUser('id') userId: string) {
    return this.productsService.create(dto, userId);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a product (admin/stock manager)' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a product (admin/stock manager)' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Adjust stock/inventory for a product (admin/stock manager)' })
  @Patch(':id/stock')
  adjustStock(
    @Param('id') id: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.productsService.adjustStock(id, dto, userId);
  }
}
