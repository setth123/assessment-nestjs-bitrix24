import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BitrixService } from '../bitrix/bitrix.service';
import { BankDto, CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

const CONTACT_ENTITY_TYPE_ID = 3; // Loại entity "Contact" trong CRM Bitrix24
const CONTACT_SELECT = [
  'ID',
  'NAME',
  'ADDRESS',
  'ADDRESS_2',
  'ADDRESS_REGION',
  'ADDRESS_CITY',
  'PHONE',
  'EMAIL',
  'WEB',
];

/** Thông tin ngân hàng kèm ID requisite / bank detail trên Bitrix24 */
interface BankInfo extends BankDto {
  requisiteId: string;
  bankDetailId?: string;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly bitrix: BitrixService,
    private readonly config: ConfigService,
  ) {}

  /** Lấy danh sách contact (phân trang 50/lần theo Bitrix24) kèm thông tin ngân hàng */
  async findAll(start = 0) {
    const res = await this.bitrix.callBitrixAPI('crm.contact.list', {
      select: CONTACT_SELECT,
      order: { ID: 'DESC' },
      start,
    });
    const banks = await this.getBankInfo(res.result.map((c) => c.ID));
    return {
      total: res.total ?? res.result.length,
      next: res.next ?? null,
      items: res.result.map((c) => this.toContact(c, banks.get(c.ID))),
    };
  }

  /** Lấy 1 contact theo ID */
  async findOne(id: string) {
    const raw = await this.findRaw(id);
    const banks = await this.getBankInfo([id]);
    return this.toContact(raw, banks.get(id));
  }

  /** Tạo contact mới, sau đó tạo requisite + thông tin ngân hàng nếu có */
  async create(dto: CreateContactDto) {
    const { result: id } = await this.bitrix.callBitrixAPI('crm.contact.add', {
      fields: this.toFields(dto),
    });
    if (dto.bank) await this.saveBank(String(id), dto.name, dto.bank);
    return this.findOne(String(id));
  }

  /** Cập nhật contact; chỉ ghi các field được gửi lên */
  async update(id: string, dto: UpdateContactDto) {
    const current = await this.findRaw(id);
    const fields = this.toFields(dto, current);
    if (Object.keys(fields).length) {
      await this.bitrix.callBitrixAPI('crm.contact.update', { id, fields });
    }
    if (dto.bank) {
      const existing = (await this.getBankInfo([id])).get(id);
      await this.saveBank(id, dto.name ?? current.NAME, dto.bank, existing);
    }
    return this.findOne(id);
  }

  /** Xoá requisites (thông tin ngân hàng) rồi xoá contact */
  async remove(id: string) {
    await this.findRaw(id);
    const { result: requisites } = await this.bitrix.callBitrixAPI(
      'crm.requisite.list',
      {
        filter: { ENTITY_TYPE_ID: CONTACT_ENTITY_TYPE_ID, ENTITY_ID: id },
        select: ['ID'],
      },
    );
    for (const r of requisites) {
      await this.bitrix.callBitrixAPI('crm.requisite.delete', { id: r.ID });
    }
    await this.bitrix.callBitrixAPI('crm.contact.delete', { id });
    return { message: `Đã xoá contact ${id}` };
  }

  /** Lấy dữ liệu gốc của contact, ném 404 nếu không tồn tại */
  private async findRaw(id: string) {
    const { result } = await this.bitrix.callBitrixAPI('crm.contact.list', {
      filter: { ID: id },
      select: CONTACT_SELECT,
    });
    if (!result.length) {
      throw new NotFoundException(`Contact ${id} không tồn tại`);
    }
    return result[0];
  }

  /**
   * Tạo mới hoặc cập nhật thông tin ngân hàng:
   * requisite (crm.requisite.*) gắn với contact, bank detail
   * (crm.requisite.bankdetail.*) gắn với requisite.
   */
  private async saveBank(
    contactId: string,
    contactName: string,
    bank: BankDto,
    existing?: BankInfo,
  ) {
    const bankFields = {
      NAME: bank.bankName,
      RQ_BANK_NAME: bank.bankName,
      RQ_ACC_NUM: bank.accountNumber,
    };

    if (!existing) {
      const { result: requisiteId } = await this.bitrix.callBitrixAPI(
        'crm.requisite.add',
        {
          fields: {
            ENTITY_TYPE_ID: CONTACT_ENTITY_TYPE_ID,
            ENTITY_ID: contactId,
            PRESET_ID: this.config.get('BITRIX24_REQUISITE_PRESET_ID', 1),
            NAME: contactName,
          },
        },
      );
      await this.bitrix.callBitrixAPI('crm.requisite.bankdetail.add', {
        fields: { ENTITY_ID: requisiteId, ...bankFields },
      });
      return;
    }

    await this.bitrix.callBitrixAPI('crm.requisite.update', {
      id: existing.requisiteId,
      fields: { NAME: contactName },
    });
    if (existing.bankDetailId) {
      await this.bitrix.callBitrixAPI('crm.requisite.bankdetail.update', {
        id: existing.bankDetailId,
        fields: bankFields,
      });
    } else {
      await this.bitrix.callBitrixAPI('crm.requisite.bankdetail.add', {
        fields: { ENTITY_ID: existing.requisiteId, ...bankFields },
      });
    }
  }

  /** Lấy thông tin ngân hàng của nhiều contact, trả về Map<contactId, BankInfo> */
  private async getBankInfo(contactIds: string[]) {
    const banks = new Map<string, BankInfo>();
    if (!contactIds.length) return banks;

    const { result: requisites } = await this.bitrix.callBitrixAPI(
      'crm.requisite.list',
      {
        filter: {
          ENTITY_TYPE_ID: CONTACT_ENTITY_TYPE_ID,
          ENTITY_ID: contactIds,
        },
        select: ['ID', 'ENTITY_ID'],
      },
    );
    if (!requisites.length) return banks;

    const { result: details } = await this.bitrix.callBitrixAPI(
      'crm.requisite.bankdetail.list',
      {
        filter: { ENTITY_ID: requisites.map((r) => r.ID) },
        select: ['ID', 'ENTITY_ID', 'RQ_BANK_NAME', 'RQ_ACC_NUM'],
      },
    );

    for (const r of requisites) {
      if (banks.has(r.ENTITY_ID)) continue; // chỉ lấy requisite đầu tiên
      const d = details.find((x) => x.ENTITY_ID === r.ID);
      banks.set(r.ENTITY_ID, {
        requisiteId: r.ID,
        bankDetailId: d?.ID,
        bankName: d?.RQ_BANK_NAME ?? '',
        accountNumber: d?.RQ_ACC_NUM ?? '',
      });
    }
    return banks;
  }

  /** Chuyển DTO thành fields của Bitrix24 */
  private toFields(dto: UpdateContactDto, current?: any) {
    const fields: Record<string, any> = {};
    if (dto.name !== undefined) fields.NAME = dto.name;
    if (dto.address) {
      const { street, ward, district, city } = dto.address;
      if (street !== undefined) fields.ADDRESS = street;
      if (ward !== undefined) fields.ADDRESS_2 = ward;
      if (district !== undefined) fields.ADDRESS_REGION = district;
      if (city !== undefined) fields.ADDRESS_CITY = city;
    }
    if (dto.phone !== undefined) {
      fields.PHONE = this.multiField(current?.PHONE, dto.phone, 'WORK');
    }
    if (dto.email !== undefined) {
      fields.EMAIL = this.multiField(current?.EMAIL, dto.email, 'WORK');
    }
    if (dto.website !== undefined) {
      fields.WEB = this.multiField(current?.WEB, dto.website, 'WORK');
    }
    return fields;
  }

  /**
   * Field nhiều giá trị (PHONE/EMAIL/WEB): nếu đã có giá trị thì gửi kèm ID
   * để Bitrix24 ghi đè, nếu không Bitrix24 sẽ thêm giá trị mới.
   */
  private multiField(existing: any[] | undefined, value: string, type: string) {
    const id = existing?.[0]?.ID;
    return [{ ...(id ? { ID: id } : {}), VALUE: value, VALUE_TYPE: type }];
  }

  /** Chuyển dữ liệu Bitrix24 thành response gọn gàng */
  private toContact(c: any, bank?: BankInfo) {
    return {
      id: c.ID,
      name: c.NAME,
      address: {
        street: c.ADDRESS ?? null,
        ward: c.ADDRESS_2 ?? null,
        district: c.ADDRESS_REGION ?? null,
        city: c.ADDRESS_CITY ?? null,
      },
      phone: c.PHONE?.[0]?.VALUE ?? null,
      email: c.EMAIL?.[0]?.VALUE ?? null,
      website: c.WEB?.[0]?.VALUE ?? null,
      bank: bank
        ? { bankName: bank.bankName, accountNumber: bank.accountNumber }
        : null,
    };
  }
}
