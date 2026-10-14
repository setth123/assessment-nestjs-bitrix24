import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { BitrixBatchError, BitrixService } from '../bitrix/bitrix.service';
import { ContactsService } from './contacts.service';

const dto = {
  name: 'A',
  bank: { bankName: 'ACB', accountNumber: '123456' },
};

describe('ContactsService', () => {
  let service: ContactsService;
  const bitrix = { callBitrixAPI: jest.fn(), callBatch: jest.fn() };
  const config = { get: jest.fn() };

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    jest.resetAllMocks();
    config.get.mockImplementation((_k: string, def: any) => def);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContactsService,
        { provide: BitrixService, useValue: bitrix },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(ContactsService);
  });

  const mockPreset = (preset: any) =>
    bitrix.callBitrixAPI.mockImplementation(async (method: string) => {
      if (method === 'crm.requisite.preset.list') {
        return { result: preset ? [preset] : [] };
      }
      return { result: [] };
    });

  it('không tạo contact khi preset không tồn tại', async () => {
    mockPreset(null);

    await expect(service.create(dto)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(bitrix.callBatch).not.toHaveBeenCalled();
  });

  it('không tạo contact khi preset bị tắt', async () => {
    mockPreset({ ID: '1', NAME: 'Công ty', ACTIVE: 'N' });

    await expect(service.create(dto)).rejects.toThrow('đang bị tắt');
    expect(bitrix.callBatch).not.toHaveBeenCalled();
  });

  it('tạo contact + requisite + bank trong 1 batch', async () => {
    mockPreset({ ID: '1', NAME: 'Công ty', ACTIVE: 'Y' });
    bitrix.callBatch.mockResolvedValue({ contact: 5, requisite: 6, bank: 7 });
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: '5' } as any);

    await service.create(dto);

    const commands = bitrix.callBatch.mock.calls[0][0];
    expect(Object.keys(commands)).toEqual(['contact', 'requisite', 'bank']);
    expect(commands.requisite.params.fields.ENTITY_ID).toBe('$result[contact]');
    expect(commands.bank.params.fields.ENTITY_ID).toBe('$result[requisite]');
    expect(service.findOne).toHaveBeenCalledWith('5');
  });

  it('xoá contact vừa tạo khi batch lỗi giữa chừng', async () => {
    mockPreset({ ID: '1', ACTIVE: 'Y' });
    bitrix.callBatch.mockRejectedValue(
      new BitrixBatchError('lỗi', { contact: 5 }),
    );

    await expect(service.create(dto)).rejects.toThrow('lỗi');
    expect(bitrix.callBitrixAPI).toHaveBeenCalledWith('crm.contact.delete', {
      id: '5',
    });
  });
});
