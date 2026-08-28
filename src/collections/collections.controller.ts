import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { QueryCollectionsDto } from './dto/query-collections.dto';

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Public()
  @ApiOperation({ summary: 'List collections' })
  @Get()
  findAll(@Query() query: QueryCollectionsDto) {
    return this.collectionsService.findAll(query);
  }

  @Public()
  @ApiOperation({ summary: 'Get a collection by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.collectionsService.findOne(id);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a collection (admin/stock manager)' })
  @Post()
  create(@Body() dto: CreateCollectionDto) {
    return this.collectionsService.create(dto);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a collection (admin/stock manager)' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCollectionDto) {
    return this.collectionsService.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a collection (admin/stock manager)' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.collectionsService.remove(id);
  }
}
