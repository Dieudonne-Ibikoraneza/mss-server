import { Body, Controller, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { badRequest } from '@/common/errors/app-error';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { RoomsService } from './rooms.service';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';
import { ListSharedDesignsDto } from './dto/list-shared-designs.dto';
import { StorageService } from '@/storage/storage.service';

const ROOM_THUMBNAIL_MAX_SIZE = 10 * 1024 * 1024;
const ROOM_THUMBNAIL_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const STAFF_ROLES: Role[] = [Role.ADMIN, Role.SALES_PERSON, Role.STOCK_MANAGER];

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly roomsService: RoomsService,
    private readonly storageService: StorageService,
  ) {}

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
  @ApiOperation({ summary: 'Upload a 3D room thumbnail (admin only)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @Post('upload-thumbnail')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: ROOM_THUMBNAIL_MAX_SIZE },
    fileFilter: (_request, file, callback) => {
      if (!ROOM_THUMBNAIL_MIME_TYPES.includes(file.mimetype)) {
        callback(badRequest('upload.imageTypeNotAllowed', 'Only JPEG, PNG, and WebP images are allowed.'), false);
        return;
      }
      callback(null, true);
    },
  }))
  uploadThumbnail(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw badRequest('upload.imageRequired', 'An image file is required in the "file" field.');
    return this.storageService.uploadRoomThumbnail(file);
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a room thumbnail (admin only)' })
  @Patch(':id')
  updateRoom(@Param('id') id: string, @Body() dto: UpdateRoomDto) {
    return this.roomsService.updateRoom(id, dto);
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
  @ApiOperation({
    summary: 'Get a room design by id',
    description: 'The owner, or staff when the owner has shared it with sales.',
  })
  @Get('designs/:id')
  findDesign(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.roomsService.findDesign(id, user.id, STAFF_ROLES.includes(user.role));
  }
}
