# Website Chatbot Hỗ Trợ Phần Mềm — Dùng chung cho nhiều chuyên gia

Đây là bản **website thật**, khác với bản demo trước (artifact) ở chỗ:
- Cơ sở tri thức, cài đặt, nhật ký câu hỏi được lưu trên **server dùng chung** — mọi chuyên gia mở cùng 1 link sẽ thấy cùng dữ liệu.
- Chatbot gọi Claude API trực tiếp bằng API key riêng của bạn (không qua Claude.ai).
- Có thể gửi câu hỏi thẳng vào Zalo OA (tuỳ chọn, xem phần Zalo bên dưới).

## Cách 1 — Triển khai lên Render.com (miễn phí, khuyên dùng nếu chưa có server)

### Bước 1: Đưa code lên GitHub
1. Tạo 1 repository mới trên https://github.com (có thể để Private).
2. Tải toàn bộ thư mục `chatbot-website` này lên repository đó (kéo-thả trên GitHub web, hoặc dùng Git nếu quen).

### Bước 2: Tạo Web Service trên Render
1. Vào https://render.com → đăng ký/đăng nhập (có thể dùng tài khoản GitHub để đăng nhập nhanh).
2. Bấm **New → Web Service**, chọn repository vừa tạo.
3. Điền cấu hình:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (đủ dùng để test/nội bộ)
4. Ở mục **Environment Variables**, thêm các biến giống trong file `.env.example`:
   - `ANTHROPIC_API_KEY` = key bạn lấy từ console.anthropic.com
   - `ADMIN_TOKEN` = tự đặt 1 mật khẩu quản trị riêng
   - (tuỳ chọn) `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_CALLBACK_URL`
5. Bấm **Create Web Service**. Render sẽ tự build và chạy, sau khoảng 1-2 phút bạn sẽ có 1 địa chỉ dạng:
   ```
   https://ten-du-an-cua-ban.onrender.com
   ```
6. Gửi link này cho các chuyên gia — ai mở cũng thấy cùng 1 cơ sở tri thức và cài đặt.

> Lưu ý gói Free của Render: server sẽ "ngủ" sau ~15 phút không có ai truy cập, lần mở lại đầu tiên sẽ hơi chậm (khoảng 30-50 giây) trong lúc server khởi động lại. Nếu cần luôn sẵn sàng, nâng cấp gói trả phí thấp nhất của Render.

## Cách 2 — Chạy trên VPS / server riêng / hạ tầng nội bộ cơ quan

```bash
cd chatbot-website
npm install
cp .env.example .env
# mở .env điền ANTHROPIC_API_KEY, ADMIN_TOKEN (và Zalo nếu dùng)
npm start
```

Sau đó dùng Nginx/Apache để trỏ domain nội bộ vào cổng chạy server (mặc định 3000), hoặc dùng PM2 (`pm2 start server.js`) để server tự chạy lại khi khởi động lại máy.

## Kích hoạt gửi câu hỏi qua Zalo OA (tuỳ chọn)

Xem chi tiết các bước OAuth, lấy user_id chuyên gia trong phần code (`server.js`) — về cơ bản:
1. Cấu hình `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_CALLBACK_URL` (trỏ về `https://<domain-cua-ban>/oauth/callback`).
2. Trong cấu hình App trên developers.zalo.me, khai báo đúng Callback URL và Webhook URL (`https://<domain-cua-ban>/webhook`).
3. Mở `https://<domain-cua-ban>/oauth/start` một lần để cấp quyền.
4. Nhờ chuyên gia nhắn 1 tin vào OA, gọi `GET /admin/recent-senders` (kèm header `x-admin-token`) để lấy user_id, rồi `PUT /admin/expert` để gán.

Nếu chưa cấu hình Zalo, chatbot vẫn hoạt động bình thường — chỉ là nút "Gửi câu hỏi cho chuyên gia" sẽ báo "chưa gửi được" và câu hỏi vẫn được lưu vào nhật ký ở tab Cài đặt để bạn xem lại thủ công.

## Mã quản trị (ADMIN_TOKEN)

- Nếu bạn đặt `ADMIN_TOKEN` trong biến môi trường, mọi thao tác **sửa/xoá/nhập** tài liệu và cài đặt sẽ yêu cầu nhập đúng mã này (ô "Mã quản trị" ở cuối tab Cài đặt trên web).
- Việc **xem** tài liệu và **chat hỏi đáp** thì ai cũng dùng được, không cần mã.
- Nên chia sẻ mã này riêng cho nhóm chuyên gia được phép chỉnh sửa nội dung, tránh người ngoài vào sửa tài liệu.
- Nếu để trống `ADMIN_TOKEN`, ai cũng sửa được — chỉ nên làm vậy khi test nội bộ.

## Giới hạn hiện tại (nên biết trước khi dùng thật)

- Dữ liệu lưu bằng file JSON trên server (`data/kb.json`, `data/settings.json`...) — đơn giản, dễ hiểu, nhưng nếu dùng lâu dài với lượng dữ liệu lớn nên chuyển sang database thật (Postgres, MongoDB...).
- Chưa có tài khoản đăng nhập riêng cho từng chuyên gia (chỉ có 1 mã quản trị dùng chung) — nếu cần phân quyền theo từng người, cần bổ sung hệ thống đăng nhập.
- Trên gói Free của Render, dữ liệu file JSON có thể bị mất khi server khởi động lại (do ổ đĩa không bền vững ở gói free) — nếu dùng thật lâu dài, nên nâng cấp gói có "Persistent Disk" hoặc chuyển sang database ngoài (Render/Railway đều có Postgres free tier riêng).
