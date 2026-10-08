import { Module } from '@nestjs/common';
import { BitrixModule } from '../bitrix/bitrix.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [BitrixModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
