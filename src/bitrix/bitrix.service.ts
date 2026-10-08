import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';

/** Cấu trúc response chuẩn của Bitrix24 REST API */
export interface BitrixResponse<T = any> {
  result: T;
  total?: number;
  next?: number;
}

const TOKEN_ERRORS = ['expired_token', 'invalid_token'];
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class BitrixService {
  private readonly logger = new Logger(BitrixService.name);

  constructor(
    private readonly http: HttpService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Hàm chung gọi Bitrix24 REST API.
   * @param method  tên method, vd: crm.contact.list
   * @param payload dữ liệu gửi đi
   * Nếu token hết hạn / không hợp lệ: refresh token rồi thử lại đúng 1 lần.
   */
  async callBitrixAPI<T = any>(
    method: string,
    payload: Record<string, any> = {},
    retry = true,
  ): Promise<BitrixResponse<T>> {
    const token = await this.auth.getValidToken();
    const url = `${token.client_endpoint}${method}.json`;

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          url,
          { ...payload, auth: token.access_token },
          { timeout: REQUEST_TIMEOUT_MS },
        ),
      );
      return data;
    } catch (err) {
      const error = err as AxiosError<any>;
      const code = error.response?.data?.error;

      if (retry && TOKEN_ERRORS.includes(code)) {
        this.logger.warn(`${method}: ${code}, làm mới token và thử lại`);
        await this.auth.refreshToken();
        return this.callBitrixAPI<T>(method, payload, false);
      }

      throw this.toHttpException(method, error);
    }
  }

  /** Chuyển lỗi axios / Bitrix24 thành HttpException với thông báo rõ ràng */
  private toHttpException(method: string, error: AxiosError<any>) {
    const status = error.response?.status;
    const code = error.response?.data?.error;
    const description =
      error.response?.data?.error_description || code || error.message;

    this.logger.error(
      `${method} thất bại [${status ?? error.code}]: ${description}`,
    );

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new GatewayTimeoutException('Bitrix24 không phản hồi (timeout)');
    }
    if (!error.response) {
      return new ServiceUnavailableException(
        'Không thể kết nối tới Bitrix24 (lỗi mạng)',
      );
    }
    if (status === 401 || TOKEN_ERRORS.includes(code)) {
      return new UnauthorizedException(
        'Token Bitrix24 không hợp lệ, vui lòng cài đặt lại ứng dụng',
      );
    }
    if (status === 404 || /not found/i.test(description)) {
      return new NotFoundException(`Bitrix24: ${description}`);
    }
    if (status && status < 500) {
      return new BadRequestException(`Bitrix24: ${description}`);
    }
    return new BadGatewayException(`Bitrix24 lỗi server: ${description}`);
  }
}
