import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CartService } from './cart.service';
import { UpsertCartItemDto } from './dto/upsert-cart-item.dto';

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @ApiOperation({ summary: "View the current user's cart" })
  @Get()
  view(@CurrentUser('id') userId: string) {
    return this.cartService.view(userId);
  }

  @ApiOperation({ summary: 'Add or update a cart item' })
  @Put('items')
  upsertItem(@CurrentUser('id') userId: string, @Body() dto: UpsertCartItemDto) {
    return this.cartService.upsertItem(userId, dto);
  }

  @ApiOperation({ summary: 'Remove an item from the cart' })
  @Delete('items/:productId')
  removeItem(@CurrentUser('id') userId: string, @Param('productId') productId: string) {
    return this.cartService.removeItem(userId, productId);
  }

  @ApiOperation({ summary: 'Clear the cart' })
  @Delete()
  clear(@CurrentUser('id') userId: string) {
    return this.cartService.clear(userId);
  }
}
