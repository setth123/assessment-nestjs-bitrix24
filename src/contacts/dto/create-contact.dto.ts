import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  ValidateNested,
} from 'class-validator';

export class AddressDto {
  @ApiPropertyOptional({ example: '12 Nguyễn Huệ' })
  @IsOptional()
  @IsString()
  street?: string;

  @ApiPropertyOptional({ example: 'Phường Bến Nghé' })
  @IsOptional()
  @IsString()
  ward?: string;

  @ApiPropertyOptional({ example: 'Quận 1' })
  @IsOptional()
  @IsString()
  district?: string;

  @ApiPropertyOptional({ example: 'TP Hồ Chí Minh' })
  @IsOptional()
  @IsString()
  city?: string;
}

export class BankDto {
  @ApiProperty({ example: 'Vietcombank' })
  @IsString()
  @IsNotEmpty({ message: 'Tên ngân hàng không được để trống' })
  bankName: string;

  @ApiProperty({ example: '0123456789' })
  @Matches(/^[A-Za-z0-9]{6,34}$/, {
    message: 'Số tài khoản không hợp lệ (6-34 ký tự, chỉ gồm chữ và số)',
  })
  accountNumber: string;
}

export class CreateContactDto {
  @ApiProperty({ example: 'Nguyễn Văn A' })
  @IsString()
  @IsNotEmpty({ message: 'Tên là bắt buộc' })
  name: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ example: '0901234567' })
  @IsOptional()
  @Matches(/^(\+84|0)[0-9]{9,10}$/, { message: 'Số điện thoại không hợp lệ' })
  phone?: string;

  @ApiPropertyOptional({ example: 'a@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @ApiPropertyOptional({ example: 'https://example.com' })
  @IsOptional()
  @IsUrl({}, { message: 'Website không hợp lệ' })
  website?: string;

  @ApiPropertyOptional({ type: BankDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BankDto)
  bank?: BankDto;
}
