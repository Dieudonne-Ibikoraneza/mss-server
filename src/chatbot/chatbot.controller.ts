import {
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
import { badRequest } from '@/common/errors/app-error';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { memoryStorage } from 'multer';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { ChatbotService } from './chatbot.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto } from './dto/media-preview.dto';
import { UpdateKnowledgeBaseEntryDto, UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
import { RecommendationDecisionDto } from './dto/recommendation-decision.dto';
import { StartConversationDto } from './dto/start-conversation.dto';
import { ListPostRecommendationInquiriesDto } from './dto/list-post-recommendation-inquiries.dto';

const ROOM_PHOTO_MAX_SIZE = 15 * 1024 * 1024;
const ROOM_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

@ApiTags('chatbot')
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send a chat message',
    description: 'Requires a signed-in customer — every conversation is tied to their account.',
  })
  @Post('messages')
  sendMessage(
    @Body() dto: SendMessageDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.chatbotService.sendMessage(dto, userId, role);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a new conversation ("project") for the signed-in customer' })
  @Post('conversations')
  startConversation(@Body() dto: StartConversationDto, @CurrentUser('id') userId: string) {
    return this.chatbotService.startConversation(userId, dto);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List the signed-in customer's conversations, most recent first" })
  @Get('conversations')
  listConversations(@CurrentUser('id') userId: string) {
    return this.chatbotService.listConversations(userId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one conversation history (owner only)' })
  @Get('conversations/:id/messages')
  getHistory(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.chatbotService.getHistory(id, userId);
  }

  @Public()
  @ApiOperation({ summary: 'Compare products via the assistant' })
  @Post('compare')
  compareProducts(@Body() dto: CompareProductsDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.chatbotService.compareProducts(dto, user?.id, user?.role);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Upload a photo of the customer's own room",
    description:
      'Returns the bare storage path to submit as `roomImagePath` to POST /chatbot/preview/image.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @Post('preview/room-photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: ROOM_PHOTO_MAX_SIZE },
      fileFilter: (_request, file, callback) => {
        if (!ROOM_PHOTO_MIME_TYPES.includes(file.mimetype)) {
          callback(
            badRequest(
              'upload.imageTypeNotAllowed',
              'Only JPEG, PNG, and WebP images are allowed.',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadRoomPhoto(@UploadedFile() file?: Express.Multer.File) {
    if (!file)
      throw badRequest(
        'chatbot.roomPhotoRequired',
        'A room photo is required in the "file" field.',
      );
    return this.chatbotService.uploadRoomPhoto(file);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Preview a tile on the customer's own room photo",
    description:
      'Edits the uploaded room photo (see POST /chatbot/preview/room-photo) to show the selected tile on its floor, and saves both the photo and the result into the conversation.',
  })
  @Post('preview/image')
  generateImagePreview(@Body() dto: ImagePreviewDto, @CurrentUser('id') userId: string) {
    return this.chatbotService.generateImagePreview(dto, userId);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record customer feedback on one of your recommendations (like/dislike)',
    description:
      'Only the customer the recommendation was made for; sets ACCEPTED, REJECTED, or clears back to PENDING.',
  })
  @Patch('recommendations/:id')
  setRecommendationDecision(
    @Param('id') id: string,
    @Body() dto: RecommendationDecisionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatbotService.setRecommendationDecision(id, dto.decision, userId);
  }

  @Public()
  @ApiOperation({ summary: 'List knowledge base entries used to ground the assistant' })
  @Get('knowledge-base')
  listKnowledgeBase(@Query('language') language?: string) {
    void language;
    return this.chatbotService.listKnowledgeBase();
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List all knowledge base entries, including inactive ones (admin only)',
  })
  @Get('admin/knowledge-base')
  listKnowledgeBaseForAdmin() {
    return this.chatbotService.listKnowledgeBaseForAdmin();
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a knowledge base entry (admin only)' })
  @Post('knowledge-base')
  createKnowledgeBaseEntry(@Body() dto: UpsertKnowledgeBaseEntryDto) {
    return this.chatbotService.createKnowledgeBaseEntry(dto);
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a knowledge base entry (admin only)' })
  @Patch('knowledge-base/:id')
  updateKnowledgeBaseEntry(@Param('id') id: string, @Body() dto: UpdateKnowledgeBaseEntryDto) {
    return this.chatbotService.updateKnowledgeBaseEntry(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a knowledge base entry (admin only)' })
  @Delete('knowledge-base/:id')
  deleteKnowledgeBaseEntry(@Param('id') id: string) {
    return this.chatbotService.deleteKnowledgeBaseEntry(id);
  }

  @Roles(Role.ADMIN, Role.DATA_ANALYST)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List questions customers asked after already receiving a recommendation (admin/marketing)',
    description: "Cursor-paginated for infinite scroll — pass the last row's id back as `cursor`.",
  })
  @Get('admin/asked-questions')
  listPostRecommendationInquiries(@Query() dto: ListPostRecommendationInquiriesDto) {
    return this.chatbotService.listPostRecommendationInquiries(dto);
  }
}
