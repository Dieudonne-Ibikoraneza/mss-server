import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Language, Role, RoomType } from '@prisma/client';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import {
  CreateProfilingQuestionDto,
  ReorderProfilingQuestionsDto,
  UpdateProfilingQuestionDto,
} from './dto/profiling-question.dto';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Public()
  @ApiOperation({
    summary: 'Read the platform settings',
    description:
      'Public because the storefront needs the platform name, currency, payment and support details.',
  })
  @Get()
  findAll() {
    return this.settingsService.findAll();
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update platform settings (admin)' })
  @Patch()
  update(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.update(dto.settings);
  }

  @Public()
  @ApiOperation({
    summary: 'List the AI customer-profiling questions',
    description: "Pass `roomType` to get the always-asked questions plus that room's conditionals.",
  })
  @Get('profiling-questions')
  listQuestions(@Query('language') language?: Language, @Query('roomType') roomType?: RoomType) {
    return roomType
      ? this.settingsService.listQuestionsForRoom(roomType, language)
      : this.settingsService.listQuestions(language);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Add a profiling question (admin)' })
  @Post('profiling-questions')
  createQuestion(@Body() dto: CreateProfilingQuestionDto) {
    return this.settingsService.createQuestion(dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Persist a new question order (admin)' })
  @Patch('profiling-questions/reorder')
  reorderQuestions(@Body() dto: ReorderProfilingQuestionsDto) {
    return this.settingsService.reorderQuestions(dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a profiling question (admin)' })
  @Patch('profiling-questions/:id')
  updateQuestion(@Param('id') id: string, @Body() dto: UpdateProfilingQuestionDto) {
    return this.settingsService.updateQuestion(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Retire a profiling question (admin)' })
  @Delete('profiling-questions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeQuestion(@Param('id') id: string) {
    return this.settingsService.removeQuestion(id);
  }
}
