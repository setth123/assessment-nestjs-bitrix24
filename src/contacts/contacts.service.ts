import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BATCH_LIMIT,
  BatchCommand,
  BitrixBatchError,
  BitrixService,
} from '../bitrix/bitrix.service';
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
export class ContactsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContactsService.name);
  private presetVerified = false;

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

  /**
   * Tạo contact mới. Nếu có bank thì tạo contact + requisite + bank detail trong
   * 1 batch; nếu batch lỗi giữa chừng thì xoá contact vừa tạo (rollback thủ công).
   */
  async create(dto: CreateContactDto) {
    if (!dto.bank) {
      const { result: id } = await this.bitrix.callBitrixAPI(
        'crm.contact.add',
        { fields: this.toFields(dto) },
      );
      return this.findOne(String(id));
    }

    await this.assertPresetValid();
    const commands: Record<string, BatchCommand> = {
      contact: {
        method: 'crm.contact.add',
        params: { fields: this.toFields(dto) },
      },
      ...this.newBankCommands('$result[contact]', dto.name, dto.bank),
    };

    let results: Record<string, any>;
    try {
      results = await this.bitrix.callBatch(commands);
    } catch (err) {
      const created = err instanceof BitrixBatchError && err.partial.contact;
      if (created) await this.rollbackContact(String(created));
      throw err;
    }
    return this.findOne(String(results.contact));
  }

  /** Cập nhật contact; chỉ ghi các field được gửi lên (gộp thành 1 batch) */
  async update(id: string, dto: UpdateContactDto) {
    const current = await this.findRaw(id);
    const commands: Record<string, BatchCommand> = {};

    const fields = this.toFields(dto, current);
    if (Object.keys(fields).length) {
      commands.contact = {
        method: 'crm.contact.update',
        params: { id, fields },
      };
    }
    if (dto.bank) {
      await this.assertPresetValid();
      const existing = (await this.getBankInfo([id])).get(id);
      Object.assign(
        commands,
        this.bankCommands(id, dto.name ?? current.NAME, dto.bank, existing),
      );
    }

    await this.bitrix.callBatch(commands);
    return this.findOne(id);
  }

  /** Xoá requisites (thông tin ngân hàng) rồi xoá contact, gộp thành batch */
  async remove(id: string) {
    await this.findRaw(id);
    const { result: requisites } = await this.bitrix.callBitrixAPI(
      'crm.requisite.list',
      {
        filter: { ENTITY_TYPE_ID: CONTACT_ENTITY_TYPE_ID, ENTITY_ID: id },
        select: ['ID'],
      },
    );

    const commands: [string, BatchCommand][] = [
      ...requisites.map((r, i): [string, BatchCommand] => [
        `requisite${i}`,
        { method: 'crm.requisite.delete', params: { id: r.ID } },
      ]),
      ['contact', { method: 'crm.contact.delete', params: { id } }],
    ];
    // Contact nằm ở lệnh cuối nên chỉ bị xoá khi mọi requisite đã xoá xong
    for (let i = 0; i < commands.length; i += BATCH_LIMIT) {
      await this.bitrix.callBatch(
        Object.fromEntries(commands.slice(i, i + BATCH_LIMIT)),
      );
    }
    return { message: `Đã xoá contact ${id}` };
  }

  /** Kiểm tra preset khi khởi động (chỉ cảnh báo, không chặn app khởi động) */
  async onApplicationBootstrap() {
    try {
      await this.assertPresetValid();
      this.logger.log(`Preset requisite ${this.presetId} hợp lệ`);
    } catch (err: any) {
      this.logger.warn(`Chưa kiểm tra được preset requisite: ${err.message}`);
    }
  }

  private get presetId() {
    return Number(this.config.get('BITRIX24_REQUISITE_PRESET_ID', 1));
  }

  /**
   * Đảm bảo BITRIX24_REQUISITE_PRESET_ID tồn tại và đang bật trên Bitrix24.
   * Gọi trước khi ghi dữ liệu để không tạo ra contact dở dang. Kết quả hợp lệ
   * được cache; nếu lỗi thì lần sau kiểm tra lại.
   */
  private async assertPresetValid() {
    if (this.presetVerified) return;
    const id = this.presetId;
    const { result } = await this.bitrix.callBitrixAPI(
      'crm.requisite.preset.list',
      { filter: { ID: id }, select: ['ID', 'NAME', 'ACTIVE'] },
    );
    const preset = Number.isInteger(id) ? result?.[0] : undefined;
    if (!preset) {
      throw new InternalServerErrorException(
        `BITRIX24_REQUISITE_PRESET_ID=${this.config.get('BITRIX24_REQUISITE_PRESET_ID', 1)} không tồn tại trên Bitrix24 (xem crm.requisite.preset.list)`,
      );
    }
    if (preset.ACTIVE === 'N') {
      throw new InternalServerErrorException(
        `Preset requisite ${id} ("${preset.NAME}") đang bị tắt trên Bitrix24`,
      );
    }
    this.presetVerified = true;
  }

  /** Xoá contact vừa tạo khi các bước sau (requisite / bank) thất bại */
  private async rollbackContact(id: string) {
    try {
      await this.bitrix.callBitrixAPI('crm.contact.delete', { id });
      this.logger.warn(`Đã rollback: xoá contact ${id} do tạo bank thất bại`);
    } catch (err: any) {
      this.logger.error(`Rollback contact ${id} thất bại: ${err.message}`);
    }
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

  /** Các lệnh batch tạo mới requisite + bank detail cho contact */
  private newBankCommands(
    contactId: string,
    contactName: string,
    bank: BankDto,
  ): Record<string, BatchCommand> {
    return {
      requisite: {
        method: 'crm.requisite.add',
        params: {
          fields: {
            ENTITY_TYPE_ID: CONTACT_ENTITY_TYPE_ID,
            ENTITY_ID: contactId,
            PRESET_ID: this.presetId,
            NAME: contactName,
          },
        },
      },
      bank: {
        method: 'crm.requisite.bankdetail.add',
        params: {
          fields: { ENTITY_ID: '$result[requisite]', ...this.bankFields(bank) },
        },
      },
    };
  }

  /**
   * Các lệnh batch tạo mới hoặc cập nhật thông tin ngân hàng:
   * requisite (crm.requisite.*) gắn với contact, bank detail
   * (crm.requisite.bankdetail.*) gắn với requisite.
   */
  private bankCommands(
    contactId: string,
    contactName: string,
    bank: BankDto,
    existing?: BankInfo,
  ): Record<string, BatchCommand> {
    if (!existing) return this.newBankCommands(contactId, contactName, bank);

    const commands: Record<string, BatchCommand> = {
      requisite: {
        method: 'crm.requisite.update',
        params: { id: existing.requisiteId, fields: { NAME: contactName } },
      },
    };
    commands.bank = existing.bankDetailId
      ? {
          method: 'crm.requisite.bankdetail.update',
          params: { id: existing.bankDetailId, fields: this.bankFields(bank) },
        }
      : {
          method: 'crm.requisite.bankdetail.add',
          params: {
            fields: {
              ENTITY_ID: existing.requisiteId,
              ...this.bankFields(bank),
            },
          },
        };
    return commands;
  }

  private bankFields(bank: BankDto) {
    return {
      NAME: bank.bankName,
      RQ_BANK_NAME: bank.bankName,
      RQ_ACC_NUM: bank.accountNumber,
    };
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
