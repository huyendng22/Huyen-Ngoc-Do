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

## Giữ dữ liệu không bị mất trên gói Free (tự nạp lại từ GitHub)

Gói Free của Render xoá sạch thư mục `data/` mỗi khi server ngủ hoặc deploy lại. Để khỏi phải tải file sao lưu lên bằng tay mỗi lần:

1. Vào tab **Cài đặt** → bấm **💾 Tải file sao lưu**. File tải về có tên dạng `sao-luu-du-lieu-chatbot-2026-09-09-10-00.json` (đã kèm cả ảnh).
2. Mở repo trên GitHub → **Add file → Upload files** → kéo file đó vào **thư mục gốc** của repo (cùng chỗ với `server.js`, **không** phải trong `public/`) → **Commit changes**.
3. Render tự deploy lại. Từ giờ, mỗi lần server khởi động mà chưa có dữ liệu, nó tự đọc file sao lưu **mới nhất** (không cần đổi tên) và khôi phục tài liệu, cài đặt, ảnh.
4. Kiểm tra: tab **Cài đặt** có khối màu xanh "✅ Lần khởi động này server đã tự nạp lại … mục + … ảnh".

Lưu ý:
- Chỉ những chỉnh sửa **đã được đưa lên GitHub** mới được giữ. Chỉnh sửa trên web sau lần upload gần nhất sẽ mất khi server khởi động lại → sau mỗi lần cập nhật quan trọng, tải file sao lưu mới và upload lại (xoá bớt file cũ cho repo gọn).
- Có nhiều file `sao-luu-du-lieu-chatbot-*.json` thì server dùng file có **ngày giờ trong tên mới nhất**. File không có ngày giờ trong tên (VD tự đặt tên tay) chỉ được dùng khi không còn file nào có ngày giờ. Muốn ép dùng 1 file cụ thể, đặt tên đúng `seed-backup.json` (được ưu tiên cao nhất).
- Server chỉ nạp khi **chưa có dữ liệu**, nên không bao giờ ghi đè lên dữ liệu đang có.
- File sao lưu chứa toàn bộ tài liệu và ảnh. Nếu nội dung là nội bộ, nên để repo ở chế độ **Private** (Render vẫn deploy được repo Private khi kết nối qua GitHub). Upload qua giao diện web GitHub giới hạn 25 MB/file.

## Quản lý tài liệu bằng Google Sheet (khuyên dùng)

Thay vì nhập từng câu trong app, chuyên gia **thêm / sửa / xoá câu hỏi ngay trong Google Sheet** (giống Excel, nhiều người cùng sửa được). Server tự đọc Sheet khi khởi động và **mỗi 5 phút**, nên Render ngủ hay khởi động lại cũng **không mất tài liệu** — dữ liệu nằm trong Sheet, không nằm trên ổ đĩa của Render.

### Thiết lập (làm 1 lần)
1. **Tạo Sheet từ file mẫu có sẵn 82 câu hỏi:** vào Google Drive → **Mới → Tải tệp lên** → chọn `du_lieu_tong_hop.xlsx` → bấm đúp file vừa tải để mở bằng **Google Trang tính (Sheets)**. (Hoặc tạo Sheet trống rồi gõ dòng tiêu đề: `Câu hỏi | Danh mục | Câu trả lời | Link Video | Link ảnh | Cách hỏi khác`.)
2. **Mở đúng tab dữ liệu** (tab "Dữ liệu", không phải tab "Hướng dẫn") rồi copy đường dẫn trên thanh địa chỉ trình duyệt (có đoạn `#gid=...`).
3. **Chia sẻ:** nút **Chia sẻ → Quyền truy cập chung → "Bất kỳ ai có đường liên kết"**, vai trò **Người xem**. Thêm email các chuyên gia làm **Người chỉnh sửa**. (Server chỉ *đọc* Sheet, không bao giờ ghi vào Sheet.)
4. **Báo cho server biết Sheet nào:** trên Render → service → **Environment → Add Environment Variable**: tên `GOOGLE_SHEET_URL`, giá trị là đường dẫn ở bước 2 → Save (Render tự khởi động lại).
   *Cách khác, không cần Render:* tạo file `google-sheet.txt` ở thư mục gốc repo GitHub, dòng đầu là đường dẫn. (Biến môi trường được ưu tiên hơn file.)
5. Mở trang quản trị → tab **Quản lý tài liệu** (hoặc **Cài đặt**) phải hiện thẻ **📊 Google Sheet** với dòng "Đồng bộ thành công gần nhất…". Có lỗi thì thẻ này hiện lý do bằng tiếng Việt (xem bảng bên dưới).

### Dùng hằng ngày
- Sửa trong Sheet → chatbot tự cập nhật trong tối đa 5 phút; muốn thấy ngay thì vào trang quản trị bấm **🔄 Đồng bộ ngay**.
- Khi đã nối Sheet, các khung thêm/sửa/xoá/nhập Excel trong app **được ẩn** (để tránh sửa ở hai nơi bị ghi đè lẫn nhau). Nút **📝 Mở Google Sheet để sửa** ngay trên trang.
- **Tab ❓ Chưa trả lời:** nút **📋 Sao chép để dán vào Sheet** chép sẵn 1 dòng (câu hỏi + các cách hỏi khác, tuỳ chọn kèm bản nháp AI). Mở Sheet, bấm vào ô A của dòng trống, dán (Ctrl+V), rồi điền Danh mục và Câu trả lời.
- Dòng 1 luôn là tiêu đề. Dòng thiếu **Câu hỏi** (cột A) hoặc **Câu trả lời** (cột C) sẽ bị bỏ qua; app liệt kê số dòng bị bỏ qua trong thẻ Google Sheet. Danh mục điền `HD` / `LOI` / `CS` / `335` / `KHAC` (hoặc tên đầy đủ).
- Cột Câu trả lời dùng định dạng như cũ: `**đậm**`, `*nghiêng*`, `__gạch chân__`, `- ` / `* ` / `1. ` đầu dòng, `## Tiêu đề phần`, `->` thành →. **Ô bắt đầu bằng dấu `=` hoặc `+`** sẽ bị Google hiểu là công thức — hãy gõ thêm dấu nháy đơn `'` đứng trước.
- **Ảnh:** ghi vào cột E, nhiều ảnh cách nhau bằng dấu `|`. Có 2 cách:
  1. **Ảnh đặt trong repo (khuyên dùng, không bao giờ mất):** kéo file ảnh vào thư mục `public/uploads` trên GitHub rồi ghi `/uploads/ten-anh.png` vào Sheet.
  2. Link ảnh `https://...` từ nơi khác.
  - **13 ảnh của bộ 82 câu hỏi mẫu:** giải nén `anh-minh-hoa.zip` được thư mục `uploads`. Trên GitHub mở thư mục `public` → **Add file → Upload files** → kéo cả thư mục `uploads` vào → Commit. Thiếu bước này thì các câu hỏi có ảnh sẽ hiện "Ảnh lỗi". (Nếu lỡ kéo từng file ảnh thẳng vào thư mục `public` thay vì thư mục `uploads` thì cũng không sao — server nhận cả hai cách.)
  - Ảnh tải lên qua giao diện app nằm trên ổ đĩa tạm nên không dùng ở chế độ Sheet. Nếu có ảnh bị thiếu, trang quản trị hiện thẻ cảnh báo **🖼️ N ảnh chưa có file trên server** kèm danh sách tên file.
- Mỗi ô Google Sheet tối đa 50.000 ký tự.

### Lưu ý bảo mật
- Sheet để chế độ "Bất kỳ ai có đường liên kết" nghĩa là **ai có link đều đọc được** (nội dung này vốn đã công khai qua chatbot). Server không để lộ đường dẫn Sheet cho người dùng thường (chỉ chuyên gia có mã quản trị mới thấy).
- **Dùng 1 Sheet RIÊNG cho tài liệu.** Đừng đặt chung file với Sheet ghi "câu hỏi chưa trả lời" (mục bên dưới) vì câu hỏi của người dùng có thể chứa thông tin cá nhân.

### Khi thẻ Google Sheet báo lỗi
Khi lỗi, chatbot **luôn giữ nguyên dữ liệu đã nạp trước đó** — không bao giờ bị trống vì Sheet hỏng.

| Thông báo | Nguyên nhân & cách xử lý |
|---|---|
| "Google trả về trang đăng nhập…" | Sheet chưa chia sẻ công khai. Làm lại bước 3. |
| "Google từ chối truy cập (mã 404/403…)" | Sai đường dẫn, hoặc Sheet đã bị xoá/đổi quyền. Copy lại đường dẫn. |
| "Không có dòng hợp lệ nào…" | Sheet trống, hoặc đang trỏ nhầm tab "Hướng dẫn". Mở đúng tab dữ liệu, copy lại đường dẫn (có `#gid=`). |
| "Không kết nối được tới Google…" | Tạm thời; server tự thử lại ở lần đồng bộ sau. |
| "Không nhận ra đường dẫn…" | Chưa dán đúng link Google Sheet (phải dạng `https://docs.google.com/spreadsheets/d/...`). |
| Thẻ "🖼️ N ảnh chưa có file trên server" / ảnh hiện "Ảnh lỗi" | Sheet nhắc tới ảnh nhưng file ảnh chưa nằm trong `public/uploads` của repo. Kéo ảnh vào đó (xem mục Ảnh ở trên), danh sách tên file thiếu nằm trong thẻ cảnh báo. |
| "Dòng 1 không giống dòng tiêu đề…" | Sheet thiếu dòng tiêu đề; dòng 1 luôn bị coi là tiêu đề nên mục ở dòng 1 không được nạp. |

Đường dẫn dạng **Tệp → Chia sẻ → Xuất bản lên web** (chọn tab + định dạng CSV) cũng dùng được; khi đó Google có thể trễ vài phút mới phản ánh thay đổi.

### Biến môi trường
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `GOOGLE_SHEET_URL` | Đường dẫn Google Sheet chứa tài liệu | (tắt — dùng cách nhập trong app như cũ) |
| `SHEET_SYNC_MINUTES` | Chu kỳ tự đồng bộ (phút) | 5 |

Bỏ biến `GOOGLE_SHEET_URL` (và file `google-sheet.txt`) thì app quay về cách quản lý trong app như trước.

## Tự động thu thập câu hỏi chatbot chưa trả lời được

Chatbot tự ghi lại những câu hỏi mà nó **không đáp ứng được**, để chuyên gia biết cần bổ sung tài liệu gì. Không cần ai làm gì thêm.

**Khi nào một câu hỏi được ghi lại**

| Tình huống | Ghi nhận là |
|---|---|
| Tài liệu không có mục nào khớp | `Tài liệu không có` |
| Có vài mục gần giống, người dùng bấm "Không đúng ý, hỏi AI" | `Có nhiều mục gần giống, không mục nào đúng ý` |
| Đã trả lời từ tài liệu nhưng người dùng bấm "Chưa đúng ý bạn? Hỏi AI thêm" | `Bấm "Chưa đúng ý bạn?"` (kèm tên mục đã gợi ý) |
| Sau đó AI trả lời được | `AI trả lời được` (kèm **bản nháp** để tham khảo) |
| AI cũng báo không có thông tin | `AI cũng không trả lời được` |
| Người dùng bấm gửi cho chuyên gia | `Đã chuyển chuyên gia` |

Các câu hỏi **giống nhau** (đổi thứ tự từ, thêm bớt vài từ — giống từ 75% trở lên) được **gộp thành 1 dòng** và đếm số lần hỏi, nên câu nào bị hỏi nhiều nhất sẽ nổi lên trên.

**Cách dùng** — tab **❓ Chưa trả lời** (số trong ngoặc là số câu chưa xử lý):
- Lọc: *Chưa xử lý* / *Cần chú ý (AI cũng không trả lời được)* / *AI trả lời được — nên bổ sung vào tài liệu* / *Đã xử lý*.
- **➕ Tạo mục tài liệu**: chuyển sang form thêm mục với câu hỏi và các cách hỏi khác đã điền sẵn. Nếu có bản nháp AI, chọn **Tạo mục kèm bản nháp AI** — bản nháp có thể sai, luôn kiểm tra trước khi lưu. Lưu xong, câu hỏi tự chuyển sang *Đã xử lý*.
- **✅ Tự đóng câu đã có đáp án**: sau khi bổ sung tài liệu hoặc "cách hỏi khác", bấm nút này, hệ thống chạy lại tìm kiếm và tự đóng những câu mà chatbot giờ đã trả lời chắc chắn được.
- **📥 Tải Excel**: xuất đúng định dạng file nhập. Điền cột **Câu trả lời** cho các câu muốn đưa vào tài liệu rồi nhập lại bằng **Nhập file Excel** (dòng để trống câu trả lời sẽ bị bỏ qua, bản nháp AI ở cột J không bao giờ tự được nhập).
- Câu đã xử lý mà **vẫn xuất hiện lại** sẽ tự được mở lại. Câu đặt *Bỏ qua* thì không mở lại (nhưng vẫn đếm số lần).
- Câu bạn gõ thử ở tab Chat cũng được ghi nhận — bấm *Bỏ qua* nếu là câu thử.

### ⚠️ Lưu trữ: trên gói Free của Render danh sách này có thể mất

Danh sách lưu trong file `data/unanswered.json` — cũng nằm trên ổ đĩa tạm, nên **mất khi server ngủ hoặc khởi động lại** (gói Free ngủ sau ~15 phút không có ai truy cập). Hai cách giữ lại:
1. **Gửi sang Google Sheet (miễn phí, khuyên dùng):** mỗi sự kiện được gửi ra ngoài ngay khi xảy ra, không phụ thuộc server còn sống hay không (xem dưới).
2. Nâng gói có *Persistent Disk*, hoặc xử lý/tải Excel thường xuyên.

Tab hiển thị rõ thông báo nếu chưa cấu hình nơi lưu bền vững, cùng giờ server khởi động lần gần nhất.

### Cấu hình lưu bền vững sang Google Sheet

1. Tạo 1 Google Sheet mới (đặt tên tuỳ ý). Menu **Tiện ích mở rộng → Apps Script**.
2. Xoá mã mẫu, dán đoạn sau, đổi `SECRET` thành 1 chuỗi bí mật tự đặt:

```javascript
const SECRET = "doi-thanh-chuoi-bi-mat-cua-ban";

// Chống "chèn công thức": nếu câu hỏi bắt đầu bằng = + - @ thì Google Sheet sẽ hiểu là công thức. Thêm dấu ' để ép thành chữ.
function safe(v) {
  const s = String(v == null ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (SECRET && d.secret !== SECRET) return ContentService.createTextOutput("forbidden");
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName("Câu hỏi") || ss.insertSheet("Câu hỏi");
    if (sh.getLastRow() === 0) {
      sh.appendRow(["Thời gian", "Câu hỏi", "Lượt hỏi mới", "Kết quả", "Tổng số lần hỏi", "Mục đã gợi ý nhưng sai", "Bản nháp AI"]);
    }
    sh.appendRow([
      new Date(d.at), safe(d.question), d.trigger || "", d.outcome || "", d.totalAsked,
      safe((d.nearTitles || []).join(" | ")), safe(d.draftAnswer),
    ]);
    return ContentService.createTextOutput("ok");
  } catch (err) {
    return ContentService.createTextOutput("error: " + err);
  }
}
```

3. Bấm **Triển khai (Deploy) → Tùy chọn triển khai mới → loại "Ứng dụng web"**: *Thực thi với tư cách* = **Tôi**, *Người có quyền truy cập* = **Bất kỳ ai** → **Triển khai** → cho phép quyền khi Google hỏi → sao chép **URL ứng dụng web** (kết thúc bằng `/exec`).
4. Trên Render: **Environment** → thêm
   - `UNANSWERED_WEBHOOK_URL` = URL vừa sao chép
   - `UNANSWERED_WEBHOOK_SECRET` = đúng chuỗi bí mật ở bước 2
5. Lưu → Render khởi động lại. Thử hỏi chatbot 1 câu lạ, vài giây sau sẽ có 1 dòng mới trong Sheet. Tab **❓ Chưa trả lời** sẽ hiện thông báo xanh "đã gửi sang nơi lưu bên ngoài".

Mỗi dòng trong Sheet là **1 sự kiện** (nên 1 lượt hỏi có thể có 2 dòng: lúc không tìm thấy và lúc có kết quả AI). Bạn có thể dùng Bảng tổng hợp (Pivot) theo cột *Câu hỏi* để đếm. Cũng có thể dùng bất kỳ dịch vụ nhận webhook nào khác (Zapier, Make, n8n…): server gửi `POST` JSON gồm `event, at, question, trigger, outcome, totalAsked, isNewQuestion, nearTitles, draftAnswer, secret`.

### Biến môi trường

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `UNANSWERED_WEBHOOK_URL` | Nơi nhận từng sự kiện (VD Google Apps Script) | (không gửi) |
| `UNANSWERED_WEBHOOK_SECRET` | Chuỗi bí mật gửi kèm để nơi nhận kiểm tra | (không) |
| `UNANSWERED_MAX` | Số dòng tối đa giữ trong app; quá số này sẽ bỏ câu đã đóng / ít người hỏi nhất trước | 2000 |

### Quyền riêng tư & bảo mật

- Chỉ lưu **nội dung câu hỏi** (tối đa 300 ký tự). **Không lưu IP hay bất kỳ định danh người hỏi nào.** Giao diện chat có ghi chú báo cho người dùng biết câu hỏi chưa trả lời được sẽ được ghi lại.
- Người dùng có thể gõ cả thông tin cá nhân vào câu hỏi — hãy tránh chia sẻ file Excel/Google Sheet này rộng rãi, và đặt **`ADMIN_TOKEN`** để chỉ chuyên gia xem được danh sách (xem mục tiếp theo). Bản ghi đã xử lý/bỏ qua quá 90 ngày tự được dọn.
- Chống spam: mỗi người dùng tối đa 40 lượt ghi nhận / 10 phút; câu hỏi tự cắt còn 300 ký tự, bỏ ký tự điều khiển; người lạ không thể tự điền lý do/số lần.

## Mã quản trị (ADMIN_TOKEN)

- Nếu bạn đặt `ADMIN_TOKEN` trong biến môi trường, mọi thao tác **sửa/xoá/nhập** tài liệu và cài đặt sẽ yêu cầu nhập đúng mã này (ô "Mã quản trị" ở cuối tab Cài đặt trên web).
- Việc **xem** tài liệu và **chat hỏi đáp** thì ai cũng dùng được, không cần mã.
- Danh sách **câu hỏi chưa trả lời** (tab ❓) cũng cần mã này để xem/xử lý; còn việc người dùng chat và được ghi nhận câu hỏi thì không cần mã.
- Nên chia sẻ mã này riêng cho nhóm chuyên gia được phép chỉnh sửa nội dung, tránh người ngoài vào sửa tài liệu.
- Nếu để trống `ADMIN_TOKEN`, ai cũng sửa được — chỉ nên làm vậy khi test nội bộ.

## Giới hạn hiện tại (nên biết trước khi dùng thật)

- Dữ liệu lưu bằng file JSON trên server (`data/kb.json`, `data/settings.json`...) — đơn giản, dễ hiểu, nhưng nếu dùng lâu dài với lượng dữ liệu lớn nên chuyển sang database thật (Postgres, MongoDB...).
- Chưa có tài khoản đăng nhập riêng cho từng chuyên gia (chỉ có 1 mã quản trị dùng chung) — nếu cần phân quyền theo từng người, cần bổ sung hệ thống đăng nhập.
- Trên gói Free của Render, ổ đĩa không bền vững: dữ liệu trên web sẽ mất khi server khởi động lại, **trừ phần đã được đưa lên GitHub dưới dạng file sao lưu** (xem mục "Giữ dữ liệu không bị mất" ở trên — server tự nạp lại từ file đó). Nếu muốn mọi chỉnh sửa tự lưu vĩnh viễn mà không cần upload, nên nâng cấp gói có "Persistent Disk" hoặc chuyển sang database ngoài (Render/Railway đều có Postgres free tier riêng).
