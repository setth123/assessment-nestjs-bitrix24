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

/** Một lệnh trong batch; params có thể chứa tham chiếu dạng '$result[<key>]' */
export interface BatchCommand {
  method: string;
  params?: Record<string, any>;
}

/** Bitrix24 giới hạn tối đa 50 lệnh cho mỗi batch */
export const BATCH_LIMIT = 50;

/** Lỗi khi một lệnh trong batch thất bại; partial chứa kết quả các lệnh đã chạy xong */
export class BitrixBatchError extends BadRequestException {
  constructor(
    message: string,
    readonly partial: Record<string, any>,
  ) {
    super(message);
  }
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

  /**
   * Gọi nhiều method trong 1 request (method `batch`), tối đa 50 lệnh.
   * Lệnh sau có thể dùng kết quả lệnh trước qua '$result[<key>]'.
   * halt = true: dừng ở lệnh lỗi đầu tiên (các lệnh đã chạy KHÔNG được rollback).
   * @returns map key -> kết quả của từng lệnh; ném BitrixBatchError nếu có lệnh lỗi
   */
  async callBatch(
    commands: Record<string, BatchCommand>,
    halt = true,
  ): Promise<Record<string, any>> {
    const keys = Object.keys(commands);
    if (!keys.length) return {};
    if (keys.length > BATCH_LIMIT) {
      throw new BadRequestException(`Batch tối đa ${BATCH_LIMIT} lệnh`);
    }

    const cmd: Record<string, string> = {};
    for (const key of keys) {
      const { method, params = {} } = commands[key];
      const query = toQuery(params).join('&');
      cmd[key] = query ? `${method}?${query}` : method;
    }

    const { result } = await this.callBitrixAPI<any>('batch', {
      halt: halt ? 1 : 0,
      cmd,
    });

    const results = asRecord(result?.result);
    const errors = asRecord(result?.result_error);
    const failed = Object.keys(errors)[0];
    if (failed) {
      const e = errors[failed];
      const description = e?.error_description || e?.error || String(e);
      this.logger.error(`batch: lệnh "${failed}" thất bại: ${description}`);
      throw new BitrixBatchError(`Bitrix24: ${description}`, results);
    }
    return results;
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

/** PHP trả về [] thay vì {} khi rỗng */
function asRecord(value: any): Record<string, any> {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? value
    : {};
}

/**
 * Mã hoá object thành query string kiểu PHP (a[b][0]=c) như Bitrix24 yêu cầu
 * trong batch. Giá trị bắt đầu bằng '$result[' được giữ nguyên để làm tham chiếu.
 */
function toQuery(value: any, prefix = ''): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      toQuery(v, prefix ? `${prefix}[${k}]` : k),
    );
  }
  const text = String(value);
  const encoded = text.startsWith('$result[') ? text : encodeURIComponent(text);
  return [`${prefix}=${encoded}`];
}
