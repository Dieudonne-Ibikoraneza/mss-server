import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryCustomersDto, QueryStaffDto } from './dto/query-users.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Get the current user profile' })
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findById(user.id);
  }

  @ApiOperation({ summary: 'Update the current user profile' })
  @Patch('me')
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @ApiOperation({
    summary: 'Close the current account',
    description:
      'Deactivates the account and revokes every session. Order and payment history is retained, so the account is switched off rather than erased.',
  })
  @Delete('me')
  deleteMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.closeOwnAccount(user.id);
  }

  @Roles(Role.ADMIN, Role.SALES_PERSON, Role.STOCK_MANAGER)
  @ApiOperation({
    summary: 'List customers with their spend summary (admin/sales/stock)',
    description:
      "Stock managers can place orders on a customer's behalf, so they need to find them too.",
  })
  @Get('customers')
  listCustomers(@Query() query: QueryCustomersDto) {
    return this.usersService.listCustomers(query);
  }

  @Roles(Role.ADMIN, Role.SALES_PERSON, Role.STOCK_MANAGER)
  @ApiOperation({
    summary: 'Get one customer with spend summary and recent orders (admin/sales/stock)',
  })
  @Get('customers/:id')
  findCustomer(@Param('id') id: string) {
    return this.usersService.findCustomer(id);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Staff head-count by role (admin only)' })
  @Get('staff/summary')
  staffSummary() {
    return this.usersService.staffSummary();
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List staff accounts (admin only)' })
  @Get('staff')
  listStaff(@Query() query: QueryStaffDto) {
    return this.usersService.listStaff(query);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Create a staff account (admin only)',
    description: 'No password is set — the staff member signs in via the same OTP flow as clients.',
  })
  @Post('staff')
  createStaff(@Body() dto: CreateStaffDto) {
    return this.usersService.createStaff(dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Edit a staff account's name, phone or role (admin only)" })
  @Patch('staff/:id')
  updateStaff(@Param('id') id: string, @Body() dto: UpdateStaffDto) {
    return this.usersService.updateStaff(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Activate/deactivate a staff account (admin only)' })
  @Patch('staff/:id/status')
  setStaffStatus(
    @Param('id') id: string,
    @Body('status') status: 'ACTIVE' | 'INACTIVE',
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.usersService.setStaffStatus(id, status, user.id);
  }
}
