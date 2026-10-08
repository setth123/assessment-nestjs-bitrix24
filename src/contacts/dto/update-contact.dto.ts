import { PartialType } from '@nestjs/swagger';
import { CreateContactDto } from './create-contact.dto';

/** Tất cả field đều optional, nhưng nếu gửi lên vẫn phải hợp lệ */
export class UpdateContactDto extends PartialType(CreateContactDto) {}
