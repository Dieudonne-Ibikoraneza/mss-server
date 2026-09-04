import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { ChatbotService } from './chatbot.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto, VideoPreviewDto } from './dto/media-preview.dto';
import { UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
import { RecommendationDecisionDto } from './dto/recommendation-decision.dto';
import { StartConversationDto } from './dto/start-conversation.dto';
import { ListPostRecommendationInquiriesDto } from './dto/list-post-recommendation-inquiries.dto';

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
  sendMessage(@Body() dto: SendMessageDto, @CurrentUser('id') userId: string) {
    return this.chatbotService.sendMessage(dto, userId);
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

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate an AI room/tile image preview' })
  @Post('preview/image')
  generateImagePreview(@Body() dto: ImagePreviewDto) {
    return this.chatbotService.generateImagePreview(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate an AI room/tile video preview' })
  @Post('preview/video')
  generateVideoPreview(@Body() dto: VideoPreviewDto) {
    return this.chatbotService.generateVideoPreview(dto);
  }

  @Public()
  @ApiOperation({
    summary: 'Record customer feedback on one recommendation (like/dislike)',
    description: 'Anonymous-safe; sets ACCEPTED, REJECTED, or clears back to PENDING.',
  })
  @Patch('recommendations/:id')
  setRecommendationDecision(@Param('id') id: string, @Body() dto: RecommendationDecisionDto) {
    return this.chatbotService.setRecommendationDecision(id, dto.decision);
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
  @ApiOperation({ summary: 'Create a knowledge base entry (admin only)' })
  @Post('knowledge-base')
  createKnowledgeBaseEntry(@Body() dto: UpsertKnowledgeBaseEntryDto) {
    return this.chatbotService.createKnowledgeBaseEntry(dto);
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
