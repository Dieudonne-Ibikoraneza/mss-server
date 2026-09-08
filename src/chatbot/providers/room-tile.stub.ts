import { Injectable } from '@nestjs/common';
import type { GeneratedImage } from './recommendation-image.provider';
import type { RoomTileEditInput, RoomTileEditProvider } from './room-tile-provider.interface';

@Injectable()
export class StubRoomTileProvider implements RoomTileEditProvider {
  generate(_input: RoomTileEditInput): Promise<GeneratedImage | null> {
    return Promise.resolve(null);
  }
}
