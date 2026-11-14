# A-Company

**[English](README.md) · Tiếng Việt**

**Đội ngũ AI tự lưu trữ trên Web, Desktop và Mobile.**

A-Company giúp tổ chức nhiều bot AI thành một nhóm làm việc: mỗi bot có vai trò, mô hình, bộ nhớ và công cụ riêng. Trao đổi với từng bot hoặc trong hội thoại nhóm, lên lịch công việc, theo dõi mức sử dụng token và kết nối mô hình do bạn lựa chọn.

Dự án mã nguồn mở theo giấy phép **Apache-2.0**, có ba cách chạy song song: **Desktop ZIP**, **Zero-Docker Lite CLI** và **Docker/server**.

## Tải về / Releases

### [Tải A-Company cho Windows x64 — ZIP khoảng 180 MB](https://github.com/phuocka/a-company/releases/download/v0.2.2/A-Company-0.2.2-Windows-x64.zip)

**[Trang release v0.2.2](https://github.com/phuocka/a-company/releases/tag/v0.2.2)** · **[Tất cả phiên bản](https://github.com/phuocka/a-company/releases)** · **[Mã kiểm tra SHA-256](https://github.com/phuocka/a-company/releases/download/v0.2.2/SHA256SUMS)**

1. Tải file ZIP và **giải nén toàn bộ** vào một thư mục trên máy.
2. Mở **`A-Company.exe`**; giữ nguyên các file đi kèm và thư mục `resources`.
3. Kết nối mô hình AI để bắt đầu sử dụng.

Bản Desktop chạy trong cửa sổ riêng, **không cần bộ cài, tab trình duyệt, Node.js, PostgreSQL hay Docker cài riêng** cho không gian làm việc tích hợp. File exe cần các tài nguyên đi kèm, không phải một file độc lập để chép riêng.

> Bản Windows hiện **chưa ký số**. Windows có thể cảnh báo hoặc chặn theo chính sách của máy; không tắt các cơ chế bảo vệ để chạy ứng dụng. Release này chỉ có gói Windows x64, chưa cung cấp bản macOS/Linux.

Mô hình đám mây cần internet và tài khoản hoặc API key phù hợp. Mô hình chạy cục bộ và các công cụ CLI tùy chọn cần được cài đặt, cấu hình riêng; ứng dụng không đóng gói sẵn mô hình AI.

## Ba cách sử dụng

| Lựa chọn | Phù hợp với | Cách bắt đầu |
| --- | --- | --- |
| **Desktop ZIP** | Người muốn tải về và mở app trên Windows | Giải nén ZIP, mở `A-Company.exe` |
| **Zero-Docker Lite CLI** | Người muốn chạy từ mã nguồn mà không cần Docker/PostgreSQL riêng | `pnpm dev:lite` |
| **Docker/server** | Nhóm cần nhiều tài khoản hoặc triển khai máy chủ | Docker Engine + Docker Compose |

**Desktop không thay thế Lite CLI hay Docker/server.** Các lựa chọn dùng chung mã nguồn và vẫn được duy trì song song. Chế độ Desktop tích hợp và Lite CLI ưu tiên không gian làm việc cục bộ; khi cần chia sẻ qua mạng và quản lý nhiều người dùng, dùng triển khai server có xác thực.

### 1. Desktop ZIP — giải nén chạy ngay

API, worker và cơ sở dữ liệu PGlite được đóng gói cùng ứng dụng. Engine chạy trong tiến trình riêng do app quản lý; khi thoát, app chờ cơ sở dữ liệu dừng.

- **Dữ liệu:** lưu tại `%APPDATA%\A-Company`, không nằm trong thư mục giải nén. Đóng app trước khi sao lưu toàn bộ thư mục này, bao gồm dữ liệu mã hóa và khóa cần để khôi phục.
- **Cập nhật:** đóng app, giải nén ZIP mới vào một thư mục mới rồi mở exe mới. Bản ZIP không dùng trình cập nhật của bộ cài.
- **Xóa app:** xóa thư mục giải nén không xóa dữ liệu làm việc đã lưu riêng.
- **Kết nối server:** dùng **File → Change A-Company Server…** nếu muốn chuyển sang Docker cục bộ hoặc máy chủ dùng chung.

Đây là bản **không cần cài đặt**, không phải gói mang cả dữ liệu cá nhân theo USB.

### 2. Zero-Docker Lite CLI — chạy từ mã nguồn

Cần Node.js tương thích (`22.22.2+` trong nhánh 22, nhánh 24 hoặc từ 26) và pnpm 9. Không cần Docker hay PostgreSQL cài riêng cho chế độ Lite.

```bash
git clone https://github.com/phuocka/a-company.git
cd a-company
pnpm install
pnpm db:generate
pnpm dev:lite
```

Mở **`http://127.0.0.1:5173`**. Lite dùng PGlite và mặc định lưu dữ liệu tại `./data/lite/pglite`; thư mục dữ liệu này tách biệt với Desktop.

### 3. Docker/server — triển khai nhiều người dùng

Giữ nguyên cách triển khai bằng Docker Compose, có xác thực, PostgreSQL và các tùy chọn máy tính Linux cô lập cho bot. Có thể triển khai trên máy cá nhân hoặc máy chủ phù hợp.

Xem **[hướng dẫn Docker trong README tiếng Anh](README.md#published-docker-images-server--vps)** và **[hướng dẫn self-host](docs/self-host.md)** để cài đặt, cấu hình HTTPS và sao lưu. Không dùng chế độ không tài khoản của Desktop/Lite như một máy chủ công khai nhiều người dùng.

## Tính năng chính

- **Làm việc với nhiều bot:** hội thoại riêng, hội thoại nhóm, vai trò và cấu hình mô hình theo bot.
- **Mô hình linh hoạt:** kết nối API đám mây, endpoint tương thích OpenAI, mô hình cục bộ hoặc các CLI được hỗ trợ như Claude Code, Codex, Gemini CLI và OpenCode. Chi phí và quyền truy cập phụ thuộc nhà cung cấp hoặc gói tài khoản tương ứng.
- **Bộ nhớ và công cụ:** bot có bộ nhớ, không gian làm việc và công cụ tùy theo cấu hình môi trường.
- **Lịch, webhook và giới hạn token:** tự động hóa công việc và kiểm soát mức sử dụng.
- **Mini-app trong hội thoại:** hiển thị nội dung tương tác trong khung cách ly.
- **Blueprint và snapshot:** xuất/nhập cấu hình nhóm và bản sao không gian làm việc; các bản xuất thông thường có cơ chế che thông tin xác thực.
- **Nhiều giao diện:** Web, Electron Desktop và ứng dụng mobile dùng chung backend; tài nguyên tải xuống tùy từng release thực tế.

## Dành cho người phát triển

```bash
pnpm desktop:dev        # Mở Desktop với engine tích hợp
pnpm desktop:portable   # Đóng gói ZIP Windows vào apps/desktop/out/portable/
pnpm lint               # Kiểm tra định dạng và lint
pnpm check              # Kiểm tra kiểu
pnpm test               # Chạy unit test
```

Xem [tài liệu kỹ thuật và kiến trúc](README.md#architecture), [phát hành Desktop](docs/desktop-release.md), [đóng góp](CONTRIBUTING.md) và [báo cáo lỗi bảo mật](SECURITY.md).

## Giấy phép

Phát hành theo [Apache License 2.0](LICENSE).
