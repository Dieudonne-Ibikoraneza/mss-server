import { Module } from '@nestjs/common';
import { NotificationsModule } from '@/notifications/notifications.module';
import { OtpService } from './otp.service';

@Module({
  imports: [NotificationsModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
