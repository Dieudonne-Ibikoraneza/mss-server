import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';
import { ListSharedDesignsDto } from './dto/list-shared-designs.dto';

const STAFF_ROLES: Role[] = [Role.ADMIN, Role.SALES_PERSON, Role.STOCK_MANAGER];

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Public()
  @ApiOperation({ summary: 'List room templates' })
  @Get()
  findAllRooms() {
    return this.roomsService.findAllRooms();
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List every room template, published or hidden (admin only)' })
  @Get('admin')
  findAllRoomsForAdmin() {
    return this.roomsService.findAllRoomsForAdmin();
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a room template (admin only)' })
  @Post()
  createRoom(@Body() dto: CreateRoomDto) {
    return this.roomsService.createRoom(dto);
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a room template, including publish/hide (admin only)' })
  @Patch(':id')
  updateRoom(@Param('id') id: string, @Body() dto: UpdateRoomDto) {
    return this.roomsService.updateRoom(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a room template (admin only)',
    description: 'Rejected if any saved customer design still uses it — hide it instead.',
  })
  @Delete(':id')
  deleteRoom(@Param('id') id: string) {
    return this.roomsService.deleteRoom(id);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save a 3D room design' })
  @Post('designs')
  saveDesign(@CurrentUser('id') userId: string, @Body() dto: SaveRoomDesignDto) {
    return this.roomsService.saveDesign(userId, dto);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List the current user's saved room designs" })
  @Get('designs/mine')
  findMyDesigns(@CurrentUser('id') userId: string) {
    return this.roomsService.findMyDesigns(userId);
  }

  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List designs shared with staff (admin/sales/stock)',
    description:
      'Newest first, cursor-paginated: pass `nextCursor` back as `cursor` for the next page. ' +
      '`search` matches the design name, the room name, or the customer name/email.',
  })
  @Get('designs/shared')
  findSharedDesigns(@Query() query: ListSharedDesignsDto) {
    return this.roomsService.findSharedDesigns(query);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a room design by id', description: 'Owner or staff only.' })
  @Get('designs/:id')
  findDesign(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.roomsService.findDesign(id, user.id, STAFF_ROLES.includes(user.role));
  }
}
