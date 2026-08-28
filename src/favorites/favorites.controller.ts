import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { FavoritesService } from './favorites.service';
import { AddFavoriteDto } from './dto/add-favorite.dto';

@ApiTags('favorites')
@ApiBearerAuth()
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @ApiOperation({ summary: "List the current user's favorites" })
  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.favoritesService.findAll(userId);
  }

  @ApiOperation({ summary: 'Add a product to favorites' })
  @Post()
  add(@CurrentUser('id') userId: string, @Body() dto: AddFavoriteDto) {
    return this.favoritesService.add(userId, dto.productId, dto.sessionId ?? userId);
  }

  @ApiOperation({ summary: 'Remove a product from favorites' })
  @Delete(':productId')
  remove(@CurrentUser('id') userId: string, @Param('productId') productId: string) {
    return this.favoritesService.remove(userId, productId);
  }
}
