import type { GeneratedImage } from './recommendation-image.provider';

export const ROOM_TILE_EDIT_PROVIDER = Symbol('ROOM_TILE_EDIT_PROVIDER');

export interface RoomTileEditInput {
  /** The customer's own uploaded room photo — the image being edited. */
  roomImage: { data: string; mimeType: string };
  /** The catalog photo of the tile they picked — the visual reference. */
  tileImage: { data: string; mimeType: string };
  product: {
    name: string;
    collection: string;
    size: string;
    description: string | null;
  };
}

export interface RoomTileEditProvider {
  generate(input: RoomTileEditInput): Promise<GeneratedImage | null>;
}
