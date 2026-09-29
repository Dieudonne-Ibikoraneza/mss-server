import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@/common/decorators/public.decorator';
import { StorageService } from './storage.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get('product-images/:token')
  async productImage(@Param('token') token: string, @Res() response: Response) {
    const blob = await this.storage.getProductImageBlob(token);
    response.set({
      'Content-Type': blob.type,
      'Content-Length': String(blob.size),
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(Buffer.from(await blob.arrayBuffer()));
  }
}
