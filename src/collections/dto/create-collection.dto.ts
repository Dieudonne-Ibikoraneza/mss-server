import { IsBoolean, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';

export class CreateCollectionDto {
  @IsString()
  @MinLength(2)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Set when the edit was authored in the Kinyarwanda admin UI — the client
   * sends the Kinyarwanda text here (not in `title`, which stays the
   * English column always) so the service knows to translate RW -> EN and
   * regenerate `title`/`description` instead of the usual EN -> RW.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  titleRw?: string;

  @IsOptional()
  @IsString()
  descriptionRw?: string;

  @IsOptional()
  @IsString()
  image?: string;

  /** Physical tile size shared by every product in this collection, e.g. "25×40cm". */
  @IsString()
  size: string;

  /** Area of a single tile of this size, in sqm — shared by every product in the collection. */
  @IsNumber()
  @IsPositive()
  tileAreaSqm: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
