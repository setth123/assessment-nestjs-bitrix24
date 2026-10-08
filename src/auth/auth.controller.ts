import { All, Body, Controller, Header, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiExcludeController()
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Endpoint Bitrix24 gọi khi cài đặt / cài đặt lại ứng dụng.
   * Trả về HTML gọi BX24.installFinish() để Bitrix24 đánh dấu cài đặt xong.
   */
  @All('install')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async install(@Query() query: any, @Body() body: any) {
    const token = await this.authService.handleInstall(query, body);
    return `<!DOCTYPE html>
<html>
<head><script src="//api.bitrix24.com/api/v1/"></script></head>
<body>
  <p>Cài đặt thành công cho ${token.domain}</p>
  <script>if (window.BX24) BX24.init(function () { BX24.installFinish(); });</script>
</body>
</html>`;
  }
}
