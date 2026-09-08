import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateRoomDto } from './create-room.dto';

export class UpdateRoomDto extends PartialType(CreateRoomDto) {
  /** Publish/hide toggle — a hidden room no longer appears in the customer-facing visualizer. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
