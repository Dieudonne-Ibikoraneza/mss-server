import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { CalculatorService } from './calculator.service';
import { FloorPlanDto } from './dto/floor-plan.dto';

@ApiTags('calculator')
@Controller('calculator')
export class CalculatorController {
  constructor(private readonly calculatorService: CalculatorService) {}

  @Public()
  @ApiOperation({ summary: 'Calculate tile quantity from a floor plan' })
  @Post('floor-plan')
  calculate(@Body() dto: FloorPlanDto) {
    return this.calculatorService.calculate(dto);
  }
}
