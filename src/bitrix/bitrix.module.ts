import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from '../auth/auth.module';
import { BitrixService } from './bitrix.service';

@Module({
  imports: [HttpModule, AuthModule],
  providers: [BitrixService],
  exports: [BitrixService],
})
export class BitrixModule {}
