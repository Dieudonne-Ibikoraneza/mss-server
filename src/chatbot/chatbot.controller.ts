import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ChatbotService } from './chatbot.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto, VideoPreviewDto } from './dto/media-preview.dto';
import { UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';

@ApiTags('chatbot')
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send a chat message',
    description:
      'Works for anonymous or logged-in visitors. Calls the AI provider, so this is rate-limited beyond the global default.',
  })
  @Post('messages')
  sendMessage(@Body() dto: SendMessageDto, @CurrentUser('id') userId?: string) {
    return this.chatbotService.sendMessage(dto, userId);
  }

  @Public()
  @ApiOperation({ summary: 'Get conversation history' })
  @Get('conversations/:id/messages')
  getHistory(@Param('id') id: string) {
    return this.chatbotService.getHistory(id);
  }

  @Public()
  @ApiOperation({ summary: 'Compare products via the assistant' })
  @Post('compare')
  compareProducts(@Body() dto: CompareProductsDto, @CurrentUser('id') userId?: string) {
    return this.chatbotService.compareProducts(dto, userId);
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
}
