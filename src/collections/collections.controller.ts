import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { memoryStorage } from 'multer';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { QueryCollectionsDto } from './dto/query-collections.dto';
import { StorageService } from '@/storage/storage.service';

const COLLECTION_IMAGE_MAX_SIZE = 10 * 1024 * 1024;
const COLLECTION_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly storageService: StorageService,
  ) {}

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload a collection image (admin/stock manager)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @Post('upload-image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: COLLECTION_IMAGE_MAX_SIZE },
      fileFilter: (_request, file, callback) => {
        if (!COLLECTION_IMAGE_MIME_TYPES.includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG, PNG, and WebP images are allowed.'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('An image file is required in the "file" field.');
    return this.storageService.uploadCollectionImage(file);
  }

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
