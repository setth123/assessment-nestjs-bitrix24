# Bitrix24 Contacts API (NestJS)

REST API bằng NestJS tích hợp Bitrix24 qua OAuth 2.0: nhận sự kiện cài đặt app, lưu và tự làm mới token, CRUD contact kèm thông tin ngân hàng (requisites).

## Cấu trúc

```
src/
├── auth/        # /install, lưu token (data/token.json), refresh token, API key guard
├── bitrix/      # callBitrixAPI(method, payload) + xử lý lỗi + unit test
├── contacts/    # GET/POST/PUT/DELETE /contacts, DTO validate
├── app.module.ts
└── main.ts      # ValidationPipe, Swagger (/docs)
data/token.json  # tạo tự động khi cài app (đã gitignore)
```

## 1. Cài đặt và chạy

Yêu cầu: Node.js >= 16 (đã test trên 20), npm.

```bash
npm install
cp .env.example .env     # rồi điền CLIENT_ID, CLIENT_SECRET, BITRIX24_DOMAIN, API_KEY
npm run start:dev        # http://localhost:3000, Swagger: http://localhost:3000/docs
```

Các lệnh khác:

```bash
npm test          # unit test
npm run lint      # ESLint
npm run format    # Prettier
npm run build && npm run start:prod
```

Biến môi trường (`.env`):

| Biến | Mô tả |
| --- | --- |
| `PORT` | Port server (mặc định 3000) |
| `CLIENT_ID`, `CLIENT_SECRET` | Lấy từ Local Application trên Bitrix24 |
| `BITRIX24_DOMAIN` | Ví dụ `your-portal.bitrix24.com` |
| `BITRIX24_REQUISITE_PRESET_ID` | Preset dùng khi tạo requisite (xem `crm.requisite.preset.list`), mặc định `1` |
| `API_KEY` | Key để gọi `/contacts` qua header `x-api-key` |

## 2. Cấu hình ngrok và Bitrix24

1. Chạy server: `npm run start:dev`
2. Mở tunnel: `ngrok http 3000` và lấy domain, ví dụ `https://abcd-1234.ngrok-free.app`
3. Trên Bitrix24: **Developer resources → Other → Local application**
   - Loại: server-side
   - **Your handler path**: `https://abcd-1234.ngrok-free.app/install`
   - **Initial installation path**: `https://abcd-1234.ngrok-free.app/install`
   - Quyền (scope): `crm`
4. Lưu lại và copy `client_id` và `client_secret` vào `.env`, rồi khởi động lại server.
5. Cài đặt (hoặc cài lại) ứng dụng. Bitrix24 sẽ gọi `/install` và token được lưu vào `data/token.json`.

> Mỗi lần ngrok đổi domain cần cập nhật lại 2 URL trên và cài lại ứng dụng.

### Luồng OAuth

`/install` hỗ trợ cả 3 dạng request Bitrix24 có thể gửi:

| Dạng | Dữ liệu nhận | Xử lý |
| --- | --- | --- |
| Local app install (POST form) | `AUTH_ID`, `REFRESH_ID`, `AUTH_EXPIRES`, `?DOMAIN=` | Lưu trực tiếp |
| Event `ONAPPINSTALL` | `auth[access_token]`, `auth[refresh_token]`, ... | Lưu trực tiếp |
| OAuth code flow | `?code=...&domain=...` | Đổi code lấy token tại `https://oauth.bitrix.info/oauth/token/` (`grant_type=authorization_code`) |

- Token được lưu ở `data/token.json` (quyền file `600`, đã gitignore) và cache trong bộ nhớ.
- `AuthService.getValidToken()` tự refresh (`grant_type=refresh_token`) khi token còn dưới 60 giây là hết hạn. Nếu có nhiều request refresh cùng lúc thì chỉ gọi refresh 1 lần.
- `BitrixService.callBitrixAPI(method, payload)` gọi `POST {client_endpoint}{method}.json` kèm `auth=<access_token>`. Nếu Bitrix24 trả về `expired_token` hoặc `invalid_token`, hàm sẽ refresh token và **thử lại đúng 1 lần**.

## 3. API endpoints

Mọi endpoint `/contacts` đều yêu cầu header `x-api-key: <API_KEY>`. Tài liệu Swagger: `/docs`.

| Method | URL | Mô tả |
| --- | --- | --- |
| `GET` | `/contacts?start=0` | Danh sách contact (50/trang, dùng `next` để lấy trang tiếp theo) |
| `GET` | `/contacts/:id` | Chi tiết 1 contact |
| `POST` | `/contacts` | Tạo contact (+ requisite + bank detail nếu có `bank`) |
| `PUT` | `/contacts/:id` | Cập nhật các field được gửi lên |
| `DELETE` | `/contacts/:id` | Xoá requisites của contact rồi xoá contact |
| `ALL` | `/install` | Bitrix24 gọi khi cài đặt app (không cần API key) |

Body của contact:

```json
{
  "name": "Nguyễn Văn A",
  "address": { "street": "12 Nguyễn Huệ", "ward": "Phường Bến Nghé", "district": "Quận 1", "city": "TP Hồ Chí Minh" },
  "phone": "0901234567",
  "email": "a@example.com",
  "website": "https://example.com",
  "bank": { "bankName": "Vietcombank", "accountNumber": "0123456789" }
}
```

Ánh xạ sang Bitrix24:

| API | Bitrix24 |
| --- | --- |
| `name` | `NAME` |
| `address.street / ward / district / city` | `ADDRESS / ADDRESS_2 / ADDRESS_REGION / ADDRESS_CITY` |
| `phone`, `email`, `website` | `PHONE`, `EMAIL`, `WEB` (multi-field, khi update sẽ ghi đè giá trị đầu tiên) |
| `bank` | `crm.requisite.add/update/delete` (gắn với contact, `ENTITY_TYPE_ID=3`) + `crm.requisite.bankdetail.*` (`RQ_BANK_NAME`, `RQ_ACC_NUM`) |

### Ví dụ cURL

```bash
API=https://abcd-1234.ngrok-free.app   # hoặc http://localhost:3000
KEY=change-me

# Danh sách
curl -H "x-api-key: $KEY" $API/contacts

# Tạo mới
curl -X POST $API/contacts -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Nguyễn Văn A","phone":"0901234567","email":"a@example.com","website":"https://example.com","address":{"ward":"Phường Bến Nghé","district":"Quận 1","city":"TP Hồ Chí Minh"},"bank":{"bankName":"Vietcombank","accountNumber":"0123456789"}}'

# Cập nhật
curl -X PUT $API/contacts/10 -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"phone":"0912345678","bank":{"bankName":"ACB","accountNumber":"999888777"}}'

# Xoá
curl -X DELETE $API/contacts/10 -H "x-api-key: $KEY"
```

## 4. Xử lý lỗi và cách kiểm tra

Các lỗi được log ra console qua `Logger` của NestJS, ví dụ: `[BitrixService] crm.contact.list thất bại [503]: ...`.

| Tình huống | HTTP trả về | Thông báo | Cách kiểm tra |
| --- | --- | --- | --- |
| Thiếu / sai API key | 401 | `API key không hợp lệ` | Gọi `/contacts` không có header |
| Chưa cài app (chưa có token) | 401 | `Ứng dụng chưa được cài đặt trên Bitrix24 (chưa có token)` | Xoá `data/token.json`, khởi động lại server rồi gọi `/contacts` |
| Access token hết hạn | (tự xử lý) | Tự refresh rồi thử lại 1 lần | Sửa `expires_at` trong `token.json` về `0`, khởi động lại server rồi gọi `/contacts` |
| Refresh token không hợp lệ | 401 | `Token Bitrix24 không hợp lệ hoặc đã hết hạn, vui lòng cài đặt lại ứng dụng` | Sửa `refresh_token` sai và `expires_at = 0` |
| Timeout (>10s) | 504 | `Bitrix24 không phản hồi (timeout)` | Unit test |
| Lỗi mạng / DNS | 503 | `Không thể kết nối tới Bitrix24 (lỗi mạng)` | Ngắt mạng rồi gọi API |
| Bitrix24 lỗi 4xx | 400 / 404 | `Bitrix24: <error_description>` | Gửi dữ liệu sai lên Bitrix24 |
| Bitrix24 lỗi 5xx | 502 | `Bitrix24 lỗi server: ...` | Unit test |
| Dữ liệu đầu vào sai | 400 | `Tên là bắt buộc`, `Email không hợp lệ`, `Số điện thoại không hợp lệ`, `Website không hợp lệ`, `Số tài khoản không hợp lệ (6-20 chữ số)` | Xem ví dụ bên dưới |
| Contact không tồn tại | 404 | `Contact 99999 không tồn tại` | `PUT/DELETE /contacts/99999` |
| ID không phải số | 400 | `Validation failed (numeric string is expected)` | `DELETE /contacts/abc` |
| `/install` thiếu dữ liệu | 400 | `Request cài đặt không hợp lệ: thiếu code hoặc AUTH_ID` | `curl -X POST $API/install` |

## 5. Kiểm thử

### Unit test (`src/bitrix/bitrix.service.spec.ts`)

```
$ npm test
PASS src/bitrix/bitrix.service.spec.ts
  BitrixService
    ✓ gọi crm.contact.list với access_token hiện tại
    ✓ refresh token và gọi lại khi Bitrix24 trả về expired_token
    ✓ trả về GatewayTimeoutException khi timeout
    ✓ trả về BadGatewayException khi Bitrix24 lỗi 5xx

Tests:       4 passed, 4 total
```

### Kết quả test bằng cURL

Các trường hợp lỗi (chạy local, chưa cài app):

```bash
$ curl -s localhost:3000/contacts
{"message":"API key không hợp lệ","error":"Unauthorized","statusCode":401}

$ curl -s -H "x-api-key: change-me" localhost:3000/contacts
{"message":"Ứng dụng chưa được cài đặt trên Bitrix24 (chưa có token)","error":"Unauthorized","statusCode":401}

$ curl -s -H "x-api-key: change-me" -H "Content-Type: application/json" -X POST localhost:3000/contacts \
    -d '{"name":"","email":"abc","phone":"12"}'
{"message":["Tên là bắt buộc","Số điện thoại không hợp lệ","Email không hợp lệ"],"error":"Bad Request","statusCode":400}

$ curl -s -H "x-api-key: change-me" -X DELETE localhost:3000/contacts/abc
{"message":"Validation failed (numeric string is expected)","error":"Bad Request","statusCode":400}

$ curl -s -X POST localhost:3000/install
{"message":"Request cài đặt không hợp lệ: thiếu code hoặc AUTH_ID","error":"Bad Request","statusCode":400}
```

Với Bitrix24 thật (sau khi cài app qua ngrok):

<!-- TODO: dán output thật sau khi test với portal Bitrix24 -->

```bash
$ curl -s -H "x-api-key: change-me" $API/contacts
# <dán kết quả GET /contacts>

$ curl -s -X POST ... $API/contacts
# <dán kết quả POST /contacts>

$ curl -s -X PUT ... $API/contacts/<id>
# <dán kết quả PUT /contacts/:id>

$ curl -s -X DELETE ... $API/contacts/<id>
# <dán kết quả DELETE /contacts/:id>
```
