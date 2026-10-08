import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  GatewayTimeoutException,
  Logger,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { BitrixService } from './bitrix.service';

const token = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: Date.now() + 3600_000,
  domain: 'test.bitrix24.com',
  client_endpoint: 'https://test.bitrix24.com/rest/',
};

/** Tạo lỗi giống AxiosError */
const axiosError = (props: Record<string, any>) =>
  Object.assign(new Error('request failed'), props);

describe('BitrixService', () => {
  let service: BitrixService;
  const http = { post: jest.fn() };
  const auth = { getValidToken: jest.fn(), refreshToken: jest.fn() };

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    jest.resetAllMocks();
    auth.getValidToken.mockResolvedValue(token);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BitrixService,
        { provide: HttpService, useValue: http },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();

    service = moduleRef.get(BitrixService);
  });

  it('gọi crm.contact.list với access_token hiện tại', async () => {
    http.post.mockReturnValue(
      of({ data: { result: [{ ID: '1', NAME: 'A' }], total: 1 } }),
    );

    const res = await service.callBitrixAPI('crm.contact.list', {
      select: ['ID'],
    });

    expect(http.post).toHaveBeenCalledWith(
      'https://test.bitrix24.com/rest/crm.contact.list.json',
      { select: ['ID'], auth: 'access-1' },
      expect.any(Object),
    );
    expect(res.result).toEqual([{ ID: '1', NAME: 'A' }]);
  });

  it('refresh token và gọi lại khi Bitrix24 trả về expired_token', async () => {
    http.post
      .mockReturnValueOnce(
        throwError(() =>
          axiosError({
            response: { status: 401, data: { error: 'expired_token' } },
          }),
        ),
      )
      .mockReturnValueOnce(of({ data: { result: [] } }));

    const res = await service.callBitrixAPI('crm.contact.list');

    expect(auth.refreshToken).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(res.result).toEqual([]);
  });

  it('trả về GatewayTimeoutException khi timeout', async () => {
    http.post.mockReturnValue(
      throwError(() => axiosError({ code: 'ECONNABORTED' })),
    );

    await expect(service.callBitrixAPI('crm.contact.list')).rejects.toThrow(
      GatewayTimeoutException,
    );
  });

  it('trả về BadGatewayException khi Bitrix24 lỗi 5xx', async () => {
    http.post.mockReturnValue(
      throwError(() =>
        axiosError({
          response: { status: 503, data: { error: 'INTERNAL_SERVER_ERROR' } },
        }),
      ),
    );

    await expect(service.callBitrixAPI('crm.contact.list')).rejects.toThrow(
      BadGatewayException,
    );
  });
});
