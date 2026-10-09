import { IsDateString, IsUUID, Matches, ValidateIf } from 'class-validator';
import { QueryMovementsDto } from './query-movements.dto';

export class QueryStockExportDto extends QueryMovementsDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  collectionId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;
}
