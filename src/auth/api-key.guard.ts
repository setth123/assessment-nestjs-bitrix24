import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bảo vệ API bằng header x-api-key (so với biến môi trường API_KEY) */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.config.get<string>('API_KEY');
    if (!apiKey || request.headers['x-api-key'] !== apiKey) {
      throw new UnauthorizedException('API key không hợp lệ');
    }
    return true;
  }
}
