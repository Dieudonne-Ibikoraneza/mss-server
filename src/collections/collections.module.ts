import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { StorageModule } from '@/storage/storage.module';
import { TranslationModule } from '@/translation/translation.module';

@Module({
  imports: [StorageModule, TranslationModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
