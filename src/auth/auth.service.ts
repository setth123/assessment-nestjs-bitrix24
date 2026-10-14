import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

/** Token được lưu trong data/token.json */
export interface BitrixToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // timestamp (ms) lúc access_token hết hạn
  domain: string;
  client_endpoint: string; // vd: https://your-portal.bitrix24.com/rest/
  member_id?: string;
}

const TOKEN_FILE = join(process.cwd(), 'data', 'token.json');
const OAUTH_URL = 'https://oauth.bitrix.info/oauth/token/';
const EXPIRY_MARGIN_MS = 60_000; // làm mới sớm 1 phút trước khi hết hạn

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private token: BitrixToken | null = null;
  private refreshing: Promise<BitrixToken> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Xử lý request cài đặt ứng dụng từ Bitrix24. Hỗ trợ 3 dạng:
   * 1. Local app: Bitrix24 POST thẳng AUTH_ID / REFRESH_ID (form-urlencoded)
   * 2. Event ONAPPINSTALL: body chứa auth[access_token], auth[refresh_token]...
   * 3. OAuth code flow: ?code=... -> đổi code lấy token
   */
  async handleInstall(query: Record<string, any>, body: Record<string, any>) {
    if (body?.AUTH_ID) {
      const domain = query.DOMAIN || this.config.get('BITRIX24_DOMAIN');
      return this.saveToken({
        access_token: body.AUTH_ID,
        refresh_token: body.REFRESH_ID,
        expires_in: Number(body.AUTH_EXPIRES) || 3600,
        domain,
        member_id: body.member_id,
      });
    }

    if (body?.auth?.access_token) {
      return this.saveToken(body.auth);
    }

    if (query.code) {
      const data = await this.requestToken({
        grant_type: 'authorization_code',
        code: query.code,
      });
      return this.saveToken(data);
    }

    throw new BadRequestException(
      'Request cài đặt không hợp lệ: thiếu code hoặc AUTH_ID',
    );
  }

  /** Trả về access_token còn hạn, tự động refresh nếu sắp hết hạn */
  async getValidToken(): Promise<BitrixToken> {
    const token = await this.loadToken();
    if (Date.now() < token.expires_at - EXPIRY_MARGIN_MS) return token;
    this.logger.log('Access token hết hạn, đang làm mới...');
    return this.refreshToken();
  }

  /** Dùng refresh_token để lấy access_token mới (gộp các lần gọi đồng thời) */
  async refreshToken(): Promise<BitrixToken> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const current = await this.loadToken();
        const data = await this.requestToken({
          grant_type: 'refresh_token',
          refresh_token: current.refresh_token,
        });
        // oauth.bitrix.info trả về domain của chính nó, giữ lại domain của portal
        return this.saveToken({ ...current, ...data, domain: current.domain });
      })().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  /** Gọi oauth.bitrix.info để lấy token (authorization_code hoặc refresh_token) */
  private async requestToken(params: Record<string, string>) {
    try {
      const { data } = await firstValueFrom(
        this.http.get(OAUTH_URL, {
          params: {
            ...params,
            client_id: this.config.get('CLIENT_ID'),
            client_secret: this.config.get('CLIENT_SECRET'),
          },
          timeout: 10_000,
        }),
      );
      if (data.error) throw { response: { data } };
      return data;
    } catch (err: any) {
      const detail = err.response?.data?.error_description || err.message;
      this.logger.error(`Lấy token thất bại (${params.grant_type}): ${detail}`);
      throw new UnauthorizedException(
        'Token Bitrix24 không hợp lệ hoặc đã hết hạn, vui lòng cài đặt lại ứng dụng',
      );
    }
  }

  /** Chuẩn hoá và lưu token ra file JSON (quyền 600 - chỉ owner đọc được) */
  private async saveToken(raw: Record<string, any>): Promise<BitrixToken> {
    const domain = raw.domain || this.config.get('BITRIX24_DOMAIN');
    const token: BitrixToken = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: Date.now() + Number(raw.expires_in || 3600) * 1000,
      domain,
      client_endpoint: raw.client_endpoint || `https://${domain}/rest/`,
      member_id: raw.member_id,
    };
    await fs.mkdir(dirname(TOKEN_FILE), { recursive: true });
    await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), {
      mode: 0o600,
    });
    this.token = token;
    this.logger.log(`Đã lưu token cho ${domain}`);
    return token;
  }

  /** Đọc token từ bộ nhớ, nếu chưa có thì đọc từ file */
  private async loadToken(): Promise<BitrixToken> {
    if (this.token) return this.token;
    try {
      this.token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
      return this.token as BitrixToken;
    } catch {
      throw new UnauthorizedException(
        'Ứng dụng chưa được cài đặt trên Bitrix24 (chưa có token)',
      );
    }
  }
}
