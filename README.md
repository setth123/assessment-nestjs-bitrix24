# Bitrix24 Contacts API (NestJS)

REST API bằng NestJS tích hợp Bitrix24 qua OAuth 2.0: nhận sự kiện cài đặt app, lưu và tự làm mới token, CRUD contact kèm thông tin ngân hàng (requisites).

## Cấu trúc

```
src/
├── auth/        # /install, lưu token (data/token.json), refresh token, API key guard
├── bitrix/      # callBitrixAPI / callBatch + xử lý lỗi + unit test
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
| `BITRIX24_REQUISITE_PRESET_ID` | Preset dùng khi tạo requisite (xem `crm.requisite.preset.list`), mặc định `1`. Được kiểm tra khi khởi động và trước khi ghi bank (xem mục Batch và preset) |
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

> **Requisite** trong Bitrix24 là bản ghi "thông tin pháp lý / thanh toán" gắn với một contact (hoặc company). Thông tin ngân hàng không nằm trực tiếp trên contact mà nằm ở **bank detail** con của requisite: `Contact → Requisite → Bank detail`. Vì vậy khi có `bank`, API tạo thêm requisite rồi bank detail cho contact.

> **Xác thực `/contacts`**: `ApiKeyGuard` so sánh header `x-api-key` với biến `API_KEY` trong `.env`. Thiếu hoặc sai key (hoặc `API_KEY` chưa cấu hình) thì trả 401. `/install` không dùng guard vì do Bitrix24 gọi.

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
| `bank` (số tài khoản: 6-34 ký tự chữ/số, hỗ trợ cả IBAN) | `crm.requisite.add/update/delete` (gắn với contact, `ENTITY_TYPE_ID=3`) + `crm.requisite.bankdetail.*` (`RQ_BANK_NAME`, `RQ_ACC_NUM`) |

### Batch và kiểm tra preset

- **Batch**: `BitrixService.callBatch(commands)` gọi method `batch` của Bitrix24 (tối đa 50 lệnh/request, `halt=1` nên dừng ở lệnh lỗi đầu tiên). Lệnh sau dùng kết quả lệnh trước qua `$result[key]`.
  - `POST`: `crm.contact.add` → `crm.requisite.add` → `crm.requisite.bankdetail.add` trong 1 request. Nếu batch lỗi giữa chừng, contact vừa tạo được xoá lại (rollback thủ công, vì batch của Bitrix24 không phải transaction).
  - `PUT`: `crm.contact.update` + các lệnh requisite/bank detail gộp thành 1 batch (không rollback; lệnh lỗi thì các lệnh trước đó vẫn được giữ).
  - `DELETE`: các `crm.requisite.delete` + `crm.contact.delete` (lệnh cuối) trong batch, tự chia nhóm 50 lệnh.
- **Preset**: `BITRIX24_REQUISITE_PRESET_ID` được kiểm tra bằng `crm.requisite.preset.list` khi khởi động (chỉ log cảnh báo) và trước mỗi lần ghi bank (trả `500` nếu preset không tồn tại hoặc bị tắt, **trước khi** tạo bất cứ dữ liệu nào). Kết quả hợp lệ được cache trong bộ nhớ.

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
| Dữ liệu đầu vào sai | 400 | `Tên là bắt buộc`, `Email không hợp lệ`, `Số điện thoại không hợp lệ`, `Website không hợp lệ`, `Số tài khoản không hợp lệ (6-34 ký tự, chỉ gồm chữ và số)` | Gửi body sai định dạng (vd: `email: "abc"`) |
| Contact không tồn tại | 404 | `Contact 99999 không tồn tại` | `PUT/DELETE /contacts/99999` |
| ID không phải số | 400 | `Validation failed (numeric string is expected)` | `DELETE /contacts/abc` |
| Preset requisite sai / bị tắt | 500 | `BITRIX24_REQUISITE_PRESET_ID=9999 không tồn tại trên Bitrix24 ...` | Đặt `BITRIX24_REQUISITE_PRESET_ID=9999` rồi `POST /contacts` có `bank` |
| `/install` thiếu dữ liệu | 400 | `Request cài đặt không hợp lệ: thiếu code hoặc AUTH_ID` | `curl -X POST $API/install` |

## 5. Kiểm thử

### Unit test (`src/bitrix/bitrix.service.spec.ts`)

```
$ npm test
PASS src/bitrix/bitrix.service.spec.ts
PASS src/contacts/contacts.service.spec.ts

Tests:       11 passed, 11 total
```

- `bitrix.service.spec.ts`: gọi API, refresh token khi `expired_token`, timeout (504), lỗi 5xx (502), mã hoá `cmd` của batch và giữ tham chiếu `$result`, lỗi batch kèm kết quả đã chạy, từ chối batch quá 50 lệnh.
- `contacts.service.spec.ts`: không tạo contact khi preset không tồn tại / bị tắt, tạo contact + requisite + bank trong 1 batch, rollback contact khi batch lỗi giữa chừng.

### Kết quả test với Bitrix24 

Chạy trên portal `b24-jdet4j.bitrix24.com` (server `node dist/main`, `API=http://localhost:3000`). Token trong `data/token.json` đã hết hạn từ trước, nên request đầu tiên đồng thời kiểm tra luôn việc tự refresh token (log: `Access token hết hạn, đang làm mới...` rồi `Đã lưu token`). Contact test (ID 13) được tạo rồi xoá ngay sau đó, không để lại dữ liệu.

```bash
# GET /contacts  -> 200 (portal có 5 contact, rút gọn còn 1 item)
$ curl -s -H "x-api-key: $KEY" $API/contacts
{"total":5,"next":null,"items":[{"id":"11","name":"Nguyễn Văn G", ... },{"id":"9","name":"Phạm Minh Đức", ... "bank":{"bankName":"BIDV","accountNumber":"31410001234567"}}, ...]}

# POST /contacts -> 201 (tạo contact + requisite + bank detail)
$ curl -s -X POST $API/contacts -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d '{"name":"Test Nguyễn Văn A","phone":"0901234567","email":"test.a@example.com","website":"https://example.com","address":{"street":"12 Nguyễn Huệ","ward":"Phường Bến Nghé","district":"Quận 1","city":"TP Hồ Chí Minh"},"bank":{"bankName":"Vietcombank","accountNumber":"0123456789"}}'
{"id":"13","name":"Test Nguyễn Văn A","address":{"street":"12 Nguyễn Huệ","ward":"Phường Bến Nghé","district":"Quận 1","city":"TP Hồ Chí Minh"},"phone":"0901234567","email":"test.a@example.com","website":"https://example.com","bank":{"bankName":"Vietcombank","accountNumber":"0123456789"}}

# GET /contacts/:id -> 200
$ curl -s -H "x-api-key: $KEY" $API/contacts/1
{"id":"1","name":"Nguyễn Công Thành","address":{"street":"12 Nguyễn Huệ", ... },"phone":"+84353136862","email":"thanh@gmail.com","website":"https://www.google.com/","bank":{"bankName":"Vietcombank","accountNumber":"0071001234567"}}

# PUT /contacts/:id -> 200 (đổi phone, cập nhật bank của requisite sẵn có)
$ curl -s -X PUT $API/contacts/13 -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d '{"phone":"0912345678","bank":{"bankName":"ACB","accountNumber":"999888777"}}'
{"id":"13","name":"Test Nguyễn Văn A", ... "phone":"0912345678", ... "bank":{"bankName":"ACB","accountNumber":"999888777"}}

# DELETE /contacts/:id -> 200 (xoá requisite rồi xoá contact)
$ curl -s -X DELETE -H "x-api-key: $KEY" $API/contacts/13
{"message":"Đã xoá contact 13"}

# GET sau khi xoá -> 404
$ curl -s -H "x-api-key: $KEY" $API/contacts/13
{"message":"Contact 13 không tồn tại","error":"Not Found","statusCode":404}
```

Các trường hợp lỗi:

```bash
$ curl -s $API/contacts                                   # thiếu API key -> 401
{"message":"API key không hợp lệ","error":"Unauthorized","statusCode":401}

$ curl -s -X POST $API/contacts -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d '{"name":"","email":"abc","phone":"12"}'            # -> 400
{"message":["Tên là bắt buộc","Số điện thoại không hợp lệ","Email không hợp lệ"],"error":"Bad Request","statusCode":400}

$ curl -s -X DELETE -H "x-api-key: $KEY" $API/contacts/abc # -> 400
{"message":"Validation failed (numeric string is expected)","error":"Bad Request","statusCode":400}

$ curl -s -X PUT $API/contacts/99999 -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d '{"phone":"0912345678"}'                            # -> 404
{"message":"Contact 99999 không tồn tại","error":"Not Found","statusCode":404}

$ curl -s -X POST $API/install                             # -> 400
{"message":"Request cài đặt không hợp lệ: thiếu code hoặc AUTH_ID","error":"Bad Request","statusCode":400}
```

### Kiểm tra lại sau khi chuyển sang batch (Bitrix24)

```bash
# POST có bank (1 batch: contact + requisite + bank detail) -> 201, số tài khoản dạng chữ + số
{"id":"15","name":"Test Batch A", ... "bank":{"bankName":"Vietcombank","accountNumber":"VN12ABC34567"}}
# PUT đổi phone + bank (batch) -> 200 ; DELETE (batch) -> 200 ; GET sau khi xoá -> 404

# Số tài khoản sai ký tự ("12-34") -> 400
{"message":["bank.Số tài khoản không hợp lệ (6-34 ký tự, chỉ gồm chữ và số)"],"error":"Bad Request","statusCode":400}

# Khởi động với BITRIX24_REQUISITE_PRESET_ID=9999, POST có bank -> 500, tổng số contact vẫn là 5 (không tạo dữ liệu dở dang)
{"message":"BITRIX24_REQUISITE_PRESET_ID=9999 không tồn tại trên Bitrix24 (xem crm.requisite.preset.list)","error":"Internal Server Error","statusCode":500}
```

Log khởi động với preset đúng: `Preset requisite 1 hợp lệ`. Contact test (ID 15) đã được xoá sau khi test.
