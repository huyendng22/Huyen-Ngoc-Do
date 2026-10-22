/**
 * Website chatbot hỗ trợ phần mềm — dùng chung cho nhiều chuyên gia.
 *
 * Một server Node.js duy nhất:
 *  - Phục vụ giao diện web tĩnh (thư mục /public)
 *  - Lưu trữ DÙNG CHUNG: cơ sở tri thức (kb.json), cài đặt (settings.json),
 *    nhật ký câu hỏi chuyển chuyên gia (escalations.json) — mọi người mở
 *    cùng 1 địa chỉ web sẽ thấy CÙNG một dữ liệu.
 *  - Gọi Claude API trực tiếp bằng ANTHROPIC_API_KEY (khoá được giữ bí mật
 *    trên server, KHÔNG lộ ra trình duyệt).
 *  - Gửi câu hỏi vào Zalo OA cho chuyên gia (kế thừa từ bản thiết kế trước).
 *
 * Lưu ý bảo mật: các thao tác THAY ĐỔI dữ liệu (sửa tài liệu, đổi cài đặt)
 * yêu cầu "mã quản trị" (ADMIN_TOKEN) để tránh người lạ vào sửa. Xem README.
 */

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
require("dotenv").config();

const app = express();
// Khôi phục ảnh (tới 5MB/ảnh, base64 ~6.7MB) cần giới hạn riêng cao hơn. Phải đặt TRƯỚC bộ đọc 2MB chung bên dưới.
app.use("/api/restore-image", express.json({ limit: "12mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // để trống = không khoá (chỉ nên dùng khi test)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ZALO_APP_ID = process.env.ZALO_APP_ID;
const ZALO_APP_SECRET = process.env.ZALO_APP_SECRET;
const ZALO_CALLBACK_URL = process.env.ZALO_CALLBACK_URL;

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
app.use("/uploads", express.static(UPLOADS_DIR));
// Chấp nhận cả ảnh đặt THẲNG trong thư mục public/ của repo (khi kéo từng file ảnh lên GitHub thay vì kéo cả thư mục uploads):
// địa chỉ /uploads/ten.png vẫn tìm ra public/ten.png. Chỉ nhận file ảnh, chỉ lấy theo tên file (không đi ra ngoài thư mục public).
app.get("/uploads/:filename", (req, res, next) => {
  const base = path.basename(req.params.filename);
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(base)) return next();
  const f = path.join(__dirname, "public", base);
  if (fs.existsSync(f)) return res.sendFile(f);
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // tối đa 5MB mỗi ảnh
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("Chỉ chấp nhận file ảnh (jpg, png, gif, webp...)."));
    cb(null, true);
  },
});

const KB_FILE = path.join(DATA_DIR, "kb.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ESCALATIONS_FILE = path.join(DATA_DIR, "escalations.json");
const TOKEN_FILE = path.join(DATA_DIR, "zalo-tokens.json");
const ZALO_CONFIG_FILE = path.join(DATA_DIR, "zalo-config.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const CATEGORIES = [
  { id: "HD", label: "Hướng dẫn thao tác" },
  { id: "LOI", label: "Lỗi thường gặp" },
  { id: "CS", label: "Chính sách / Quy trình" },
  { id: "335", label: "335" },
  { id: "KHAC", label: "Khác" },
];
function getCategoryLabel(id) {
  const found = CATEGORIES.find((c) => c.id === id);
  return found ? found.label : id;
}

// Đọc TOÀN BỘ ảnh của 1 mục, gộp cả kiểu dữ liệu cũ (imageUrl/imageUrl2) lẫn kiểu mới
// (images - mảng không giới hạn số lượng), không trùng lặp. Tương ứng với hàm cùng tên phía client.
function getEntryImages(entry) {
  if (!entry) return [];
  const legacy = [entry.imageUrl, entry.imageUrl2].filter(Boolean);
  const modern = Array.isArray(entry.images) ? entry.images.filter(Boolean) : [];
  const seen = new Set();
  const result = [];
  [...legacy, ...modern].forEach((u) => {
    if (!seen.has(u)) {
      seen.add(u);
      result.push(u);
    }
  });
  return result;
}

// Chỉ lấy những ảnh CHƯA xuất hiện sẵn trong nội dung câu trả lời (đã được chuyên gia chèn thẳng
// vào giữa các bước) — tránh nhắc lại 1 link ảnh 2 lần trong ngữ cảnh gửi cho AI, đỡ tốn token.
function getGalleryImages(entry) {
  const all = getEntryImages(entry);
  const content = String((entry && entry.content) || "");
  return all.filter((u) => !content.includes(u));
}

const DEFAULT_GREETING =
  "Chào bạn, tôi là chatbot hỗ trợ phần mềm. Hãy đặt câu hỏi, tôi sẽ trả lời dựa trên tài liệu hướng dẫn đã được nạp.";
const ESCALATION_MARKER = "[CẦN_CHUYÊN_GIA]";

// ---------- Tự nạp lại dữ liệu từ file sao lưu nằm sẵn trong GitHub ----------
// Gói Free của Render xoá sạch thư mục data/ mỗi khi server ngủ hoặc khởi động lại. Để khỏi phải
// tải file sao lưu lên bằng tay mỗi lần, hãy đưa file sao lưu (tải ở tab Cài đặt) vào THƯ MỤC GỐC
// của repo GitHub, cạnh server.js. Mỗi lần server khởi động mà chưa có dữ liệu (data/kb.json chưa
// tồn tại), nó tự đọc file đó và khôi phục tài liệu + cài đặt + ảnh. Nếu server vẫn còn dữ liệu
// (VD đã gắn ổ đĩa bền vững) thì KHÔNG ghi đè.
//   - Ưu tiên 1: file tên đúng "seed-backup.json"
//   - Ưu tiên 2: file "sao-luu-du-lieu-chatbot-*.json" có dấu thời gian MỚI NHẤT trong tên
//     (VD ...-2026-09-09-10-00.json) — nhờ vậy không cần đổi tên file tải về.
const SEED_EXPLICIT_NAME = "seed-backup.json";
const SEED_PATTERN = /^sao-luu-du-lieu-chatbot-.*\.json$/i;

function findSeedFile() {
  const explicit = path.join(__dirname, SEED_EXPLICIT_NAME);
  if (fs.existsSync(explicit)) return explicit;
  let names = [];
  try {
    names = fs.readdirSync(__dirname).filter((n) => SEED_PATTERN.test(n));
  } catch (e) {
    return null;
  }
  if (names.length === 0) return null;
  // File do app tạo ra có dấu thời gian YYYY-MM-DD-HH-mm ở cuối tên -> chọn file có thời gian MỚI NHẤT.
  // File không có dấu thời gian (VD tự đặt tên) chỉ được dùng khi KHÔNG có file nào có dấu thời gian,
  // để 1 file đặt tên tay không "thắng mãi" các bản sao lưu mới hơn.
  const stamp = (n) => {
    const m = /(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\.json$/i.exec(n);
    return m ? m[1] : null;
  };
  const stamped = names.filter((n) => stamp(n)).sort((a, b) => stamp(a).localeCompare(stamp(b)));
  if (stamped.length > 0) return path.join(__dirname, stamped[stamped.length - 1]);
  names.sort();
  return path.join(__dirname, names[names.length - 1]);
}

const seedStatus = { found: false, file: null, restored: false, entries: 0, images: 0, at: null, error: null };

function restoreFromSeedIfFresh() {
  const file = findSeedFile();
  seedStatus.found = !!file;
  seedStatus.file = file ? path.basename(file) : null;
  if (!file) return;
  if (fs.existsSync(KB_FILE)) return; // đang còn dữ liệu -> giữ nguyên, không đè
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = parsed && parsed.kb && parsed.kb.entries;
    if (!Array.isArray(entries)) throw new Error("File sao lưu không đúng định dạng (thiếu kb.entries).");

    let imageCount = 0;
    const images = parsed.uploadedImages && typeof parsed.uploadedImages === "object" ? parsed.uploadedImages : {};
    for (const p of Object.keys(images)) {
      try {
        const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/.exec(String(images[p] || ""));
        const filename = path.basename(String(p)); // chỉ lấy tên file, chống ghi ra ngoài thư mục uploads
        if (!m || !String(p).startsWith("/uploads/")) continue;
        if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename === "." || filename === "..") continue;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[1], "base64"));
        imageCount++;
      } catch (e) {
        // bỏ qua 1 ảnh lỗi, vẫn khôi phục phần còn lại
      }
    }
    if (parsed.settings && typeof parsed.settings === "object") writeJson(SETTINGS_FILE, parsed.settings);
    // Ghi kb.json CUỐI CÙNG: nếu giữa chừng bị lỗi thì kb.json chưa có -> lần khởi động sau tự thử lại.
    writeJson(KB_FILE, { entries });

    seedStatus.restored = true;
    seedStatus.entries = entries.length;
    seedStatus.images = imageCount;
    seedStatus.at = new Date().toISOString();
    console.log(`[seed] Đã tự khôi phục ${entries.length} mục + ${imageCount} ảnh từ ${seedStatus.file}`);
  } catch (e) {
    seedStatus.error =
      e instanceof SyntaxError
        ? "File không phải JSON hợp lệ (có thể bị hỏng khi tải lên GitHub). Hãy tải lại file sao lưu từ tab Cài đặt rồi upload lại."
        : e.message || String(e);
    console.error(`[seed] Không nạp được ${seedStatus.file}: ${seedStatus.error}`);
  }
}
restoreFromSeedIfFresh();

let kb = readJson(KB_FILE, {
  entries: [
    {
      id: "seed-1",
      title: "Làm sao để đặt lại mật khẩu?",
      category: "HD",
      content:
        "Vào trang đăng nhập > bấm 'Quên mật khẩu' > nhập email đã đăng ký > làm theo hướng dẫn trong email.",
    },
  ],
});
const DEFAULT_NO_RESULT = "Không tìm thấy nội dung bạn đang tìm kiếm trong tài liệu. Bạn thử diễn đạt khác đi hoặc liên hệ chuyên gia để được tư vấn rõ nhất.";
let settings = { greeting: DEFAULT_GREETING, expertEmail: "", noResultMessage: DEFAULT_NO_RESULT, customCategories: [], ...readJson(SETTINGS_FILE, {}) };
let escalations = readJson(ESCALATIONS_FILE, []);
let zaloTokens = readJson(TOKEN_FILE, null);
let zaloConfig = readJson(ZALO_CONFIG_FILE, { expertUserId: null, recentSenders: [] });

// ---------- Khoá đơn giản cho các thao tác ghi/sửa dữ liệu dùng chung ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // chưa cấu hình mã quản trị -> bỏ qua (chỉ nên dùng lúc test)
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Sai mã quản trị." });
  }
  next();
}

// ================= THU THẬP CÂU HỎI CHATBOT CHƯA TRẢ LỜI ĐƯỢC =================
// Tự động ghi lại câu hỏi mà chatbot không đáp ứng được để chuyên gia biết cần bổ sung tài liệu gì.
// Mỗi bản ghi = 1 "câu hỏi" (đã gộp các cách hỏi giống nhau) kèm số lần hỏi và lý do:
//   nomatch     : tài liệu không có mục nào khớp
//   ambiguous   : có vài mục gần giống, người dùng bấm "không mục nào đúng ý"
//   kb_dislike  : đã trả lời từ tài liệu nhưng người dùng bấm "Chưa đúng ý bạn?"
//   ai_answered : sau đó AI trả lời được (kèm bản nháp để chuyên gia tham khảo)
//   ai_unknown  : AI cũng báo không có thông tin
//   escalated   : người dùng đã chuyển câu hỏi cho chuyên gia
// Quyền riêng tư: KHÔNG lưu IP hay định danh người hỏi — chỉ lưu nội dung câu hỏi.
const UNANSWERED_FILE = path.join(DATA_DIR, "unanswered.json");
const UNANSWERED_MAX = Number(process.env.UNANSWERED_MAX) || 2000; // tối đa số bản ghi giữ lại
const UNANSWERED_WEBHOOK_URL = process.env.UNANSWERED_WEBHOOK_URL || ""; // nơi lưu bền vững (VD Google Sheet)
const UNANSWERED_WEBHOOK_SECRET = process.env.UNANSWERED_WEBHOOK_SECRET || "";
const SERVER_STARTED_AT = new Date().toISOString();
const MAX_QUESTION_LEN = 300;
const MAX_SAMPLES = 8;
const KEEP_CLOSED_DAYS = 90; // bản ghi đã xử lý/bỏ qua quá 90 ngày sẽ tự dọn
const UNANSWERED_TRIGGERS = ["nomatch", "ambiguous", "kb_dislike"];
const UNANSWERED_OUTCOMES = ["ai_answered", "ai_unknown", "escalated"];
const UNANSWERED_STATUSES = ["new", "resolved", "ignored"];

// Bản sao thuật toán chuẩn hoá của giao diện (index.html) — giữ giống nhau để gộp câu hỏi cùng cách.
const VN_STOPWORDS = new Set([
  "la","cua","va","cac","nhung","co","duoc","the","nao","cho","de","khi","toi","ban","minh",
  "lam","sao","gi","nhu","nay","do","mot","voi","ve","tai","hay","hoac","da","se","phai","can",
  "muon","xin","vay","oi","nhe","trong","o","ra","vao","den","neu","thi","ma","hon",
  "nhat","nen","bi","bang","theo",
]);
function normalizeVN(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenizeVN(str) {
  return normalizeVN(str).split(" ").filter((w) => w && w.length > 1 && !VN_STOPWORDS.has(w));
}
function questionKey(q) {
  const toks = [...new Set(tokenizeVN(q))].sort(); // sắp xếp để đảo thứ tự từ vẫn coi là cùng câu hỏi
  return toks.length ? toks.join(" ") : normalizeVN(q);
}
function cleanQuestion(raw) {
  if (typeof raw !== "string") return "";
  const q = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LEN);
  return /[\p{L}\p{N}]/u.test(q) ? q : ""; // phải có ít nhất 1 chữ/số
}

let unanswered = readJson(UNANSWERED_FILE, []);
if (!Array.isArray(unanswered)) unanswered = [];

let unansweredTimer = null;
let unansweredDirty = false;
function flushUnanswered() {
  if (unansweredTimer) {
    clearTimeout(unansweredTimer);
    unansweredTimer = null;
  }
  if (!unansweredDirty) return;
  unansweredDirty = false;
  try {
    writeJson(UNANSWERED_FILE, unanswered);
  } catch (e) {
    console.error("[unanswered] Không ghi được file:", e.message);
  }
}
function scheduleUnansweredSave() {
  unansweredDirty = true;
  if (!unansweredTimer) unansweredTimer = setTimeout(flushUnanswered, 1500); // gom nhiều sự kiện vào 1 lần ghi
}
process.on("exit", flushUnanswered);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    flushUnanswered();
    process.exit(0);
  });
}

// Tìm bản ghi cùng ý: trùng khoá, hoặc giống ≥ 75% (Jaccard theo tập từ khoá, cần ≥ 2 từ).
function findUnansweredRecord(key) {
  const exact = unanswered.find((r) => r.key === key);
  if (exact) return exact;
  const toks = key.split(" ");
  if (toks.length < 2) return null;
  const set = new Set(toks);
  let best = null;
  let bestSim = 0;
  for (const r of unanswered) {
    const rt = r.key.split(" ");
    if (rt.length < 2) continue;
    let inter = 0;
    for (const t of rt) if (set.has(t)) inter++;
    const sim = inter / (set.size + rt.length - inter);
    if (sim >= 0.75 && sim > bestSim) {
      best = r;
      bestSim = sim;
    }
  }
  return best;
}

function trimUnanswered(keep) {
  const cutoff = Date.now() - KEEP_CLOSED_DAYS * 86400000;
  unanswered = unanswered.filter((r) => r === keep || r.status === "new" || new Date(r.lastAt).getTime() > cutoff);
  if (unanswered.length <= UNANSWERED_MAX) return;
  // Quá giới hạn: bỏ trước các bản ghi đã xử lý/bỏ qua, rồi tới câu mới ít người hỏi nhất & cũ nhất.
  const others = unanswered.filter((r) => r !== keep);
  const rank = (r) => (r.status === "new" ? 1 : 0);
  others.sort((a, b) => rank(a) - rank(b) || a.count - b.count || String(a.lastAt).localeCompare(String(b.lastAt)));
  others.splice(0, others.length + 1 - UNANSWERED_MAX);
  unanswered = [...others, keep];
}

// Gửi từng sự kiện sang nơi lưu bền vững (nếu có cấu hình) — chạy nền, lỗi không ảnh hưởng người dùng.
const webhookQueue = [];
let webhookBusy = false;
let webhookFailures = 0;
async function pumpWebhook() {
  if (webhookBusy) return;
  webhookBusy = true;
  try {
    while (webhookQueue.length) {
      const body = webhookQueue.shift();
      try {
        await axios.post(UNANSWERED_WEBHOOK_URL, body, { timeout: 8000, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        webhookFailures++;
        if (webhookFailures <= 5 || webhookFailures % 50 === 0) {
          console.error(`[unanswered] Gửi webhook lỗi (lần ${webhookFailures}): ${e.message}`);
        }
      }
    }
  } finally {
    webhookBusy = false;
  }
}
function sendUnansweredWebhook(payload) {
  if (!UNANSWERED_WEBHOOK_URL || webhookQueue.length >= 200) return;
  webhookQueue.push(payload);
  pumpWebhook();
}

// Ghi nhận 1 sự kiện. trigger = "lượt hỏi mới" (làm tăng số lần hỏi); outcome = kết quả của lượt đó.
function logUnanswered({ question, trigger = null, outcome = null, draft = null, nearTitles = [] }) {
  const q = cleanQuestion(question);
  if (!q) return null;
  if (trigger && !UNANSWERED_TRIGGERS.includes(trigger)) trigger = null;
  if (outcome && !UNANSWERED_OUTCOMES.includes(outcome)) outcome = null;
  const now = new Date().toISOString();
  const key = questionKey(q);
  let rec = findUnansweredRecord(key);
  const isNew = !rec;
  if (isNew) {
    rec = {
      id: `u${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
      question: q,
      key,
      count: 1,
      firstAt: now,
      lastAt: now,
      reasons: { nomatch: 0, ambiguous: 0, kb_dislike: 0, ai_answered: 0, ai_unknown: 0, escalated: 0 },
      status: "new",
      samples: [q],
      draftAnswer: null,
      nearTitles: [],
      note: "",
    };
    unanswered.push(rec);
  } else {
    if (trigger) rec.count++; // chỉ tăng "số lần hỏi" khi là 1 lượt hỏi mới, không tăng khi chỉ cập nhật kết quả
    rec.lastAt = now;
    if (!rec.samples.includes(q) && rec.samples.length < MAX_SAMPLES) rec.samples.push(q);
    if (rec.status === "resolved") {
      // Đã xử lý rồi mà câu này vẫn không trả lời được -> mở lại để chuyên gia xem lại.
      rec.status = "new";
      rec.reopenedAt = now;
      rec.note = "Mở lại: câu hỏi này vẫn xuất hiện sau khi đã xử lý.";
    }
  }
  if (trigger) rec.reasons[trigger]++;
  if (outcome) rec.reasons[outcome]++;
  if (outcome === "ai_answered" && draft) rec.draftAnswer = String(draft).slice(0, 2000);
  for (const t of Array.isArray(nearTitles) ? nearTitles : []) {
    const tt = typeof t === "string" ? t.trim().slice(0, 200) : "";
    if (tt && !rec.nearTitles.includes(tt) && rec.nearTitles.length < 5) rec.nearTitles.push(tt);
  }
  trimUnanswered(rec);
  scheduleUnansweredSave();
  sendUnansweredWebhook({
    secret: UNANSWERED_WEBHOOK_SECRET || undefined,
    event: "unanswered_question",
    at: now,
    question: q,
    trigger,
    outcome,
    totalAsked: rec.count,
    isNewQuestion: isNew,
    nearTitles: (Array.isArray(nearTitles) ? nearTitles : []).filter((t) => typeof t === "string").slice(0, 5),
    draftAnswer: outcome === "ai_answered" && draft ? String(draft).slice(0, 2000) : "",
  });
  return rec;
}

// Giới hạn tần suất ghi nhận theo người dùng (để người lạ không làm đầy nhật ký). Không lưu IP, chỉ đếm tạm trong bộ nhớ.
// Render đứng sau proxy: IP thật là phần tử CUỐI của X-Forwarded-For (phần đầu có thể do người dùng tự điền giả).
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || "unknown";
}
const eventHits = new Map();
function allowEvent(req, limit = 40, windowMs = 10 * 60 * 1000) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (eventHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    eventHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  eventHits.set(ip, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of eventHits) {
    const fresh = arr.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) eventHits.set(ip, fresh);
    else eventHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Endpoint công khai: chỉ nhận loại "nomatch" (người dùng gõ câu mà tài liệu không có) — các loại khác do server tự ghi.
app.post("/api/unanswered", (req, res) => {
  if (!allowEvent(req)) return res.status(429).json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." });
  const rec = logUnanswered({ question: (req.body || {}).question, trigger: "nomatch" });
  if (!rec) return res.status(400).json({ ok: false, error: "Câu hỏi không hợp lệ." });
  res.json({ ok: true }); // không trả dữ liệu bản ghi cho người dùng
});

// Các endpoint dưới đây dành cho chuyên gia (cần mã quản trị nếu đã bật).
app.get("/api/unanswered", requireAdmin, (req, res) => {
  const items = unanswered.map(({ key, ...rest }) => rest);
  res.json({
    ok: true,
    items,
    meta: { startedAt: SERVER_STARTED_AT, webhookConfigured: !!UNANSWERED_WEBHOOK_URL, max: UNANSWERED_MAX, total: items.length },
  });
});

app.patch("/api/unanswered/:id", requireAdmin, (req, res) => {
  const rec = unanswered.find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: "Không tìm thấy." });
  const { status, note } = req.body || {};
  if (status !== undefined) {
    if (!UNANSWERED_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: "Trạng thái không hợp lệ." });
    rec.status = status;
    if (status === "resolved") rec.resolvedAt = new Date().toISOString();
  }
  if (typeof note === "string") rec.note = note.slice(0, 300);
  scheduleUnansweredSave();
  res.json({ ok: true });
});

app.post("/api/unanswered/bulk-status", requireAdmin, (req, res) => {
  const { ids, status, note } = req.body || {};
  if (!Array.isArray(ids) || !UNANSWERED_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
  }
  const idSet = new Set(ids.filter((x) => typeof x === "string"));
  let changed = 0;
  for (const r of unanswered) {
    if (!idSet.has(r.id)) continue;
    r.status = status;
    if (status === "resolved") r.resolvedAt = new Date().toISOString();
    if (typeof note === "string") r.note = note.slice(0, 300);
    changed++;
  }
  if (changed) scheduleUnansweredSave();
  res.json({ ok: true, changed });
});

app.delete("/api/unanswered/:id", requireAdmin, (req, res) => {
  const before = unanswered.length;
  unanswered = unanswered.filter((r) => r.id !== req.params.id);
  if (unanswered.length === before) return res.status(404).json({ ok: false, error: "Không tìm thấy." });
  scheduleUnansweredSave();
  res.json({ ok: true });
});

// Dọn nhanh: xoá toàn bộ bản ghi đã xử lý / bỏ qua (?scope=closed)
app.delete("/api/unanswered", requireAdmin, (req, res) => {
  if (req.query.scope !== "closed") return res.status(400).json({ ok: false, error: "Thiếu scope=closed." });
  const before = unanswered.length;
  unanswered = unanswered.filter((r) => r.status === "new");
  if (unanswered.length !== before) scheduleUnansweredSave();
  res.json({ ok: true, removed: before - unanswered.length });
});

// ================= ĐỒNG BỘ TÀI LIỆU TỪ GOOGLE SHEET =================
// Khi có cấu hình, Google Sheet là NƠI CHỨA TÀI LIỆU: chuyên gia thêm/sửa/xoá câu hỏi ngay trong Sheet,
// server tự đọc lại khi khởi động và mỗi vài phút. Nhờ vậy dữ liệu không nằm trên ổ đĩa tạm của Render.
// Cấu hình (chọn 1): biến môi trường GOOGLE_SHEET_URL, hoặc file google-sheet.txt (dòng đầu = đường dẫn) ở thư mục gốc repo.
// Sheet cần chia sẻ "Bất kỳ ai có đường liên kết đều xem được" (hoặc Tệp → Chia sẻ → Xuất bản lên web).
// Cột (dòng 1 là tiêu đề): A Câu hỏi | B Danh mục | C Câu trả lời | D Link video | E Link ảnh | F Cách hỏi khác
const SHEET_URL_FILE = path.join(__dirname, "google-sheet.txt");
const SHEET_SYNC_MINUTES = Math.max(0.05, Number(process.env.SHEET_SYNC_MINUTES) || 5);
const SHEET_TIMEOUT_MS = Number(process.env.SHEET_TIMEOUT_MS) || 20000;
const SHEET_READONLY_MSG =
  "Tài liệu đang được đồng bộ từ Google Sheet nên không sửa trực tiếp trong app. Hãy thêm/sửa/xoá câu hỏi trong Google Sheet rồi bấm \"Đồng bộ ngay\".";

function readSheetUrlSetting() {
  const env = (process.env.GOOGLE_SHEET_URL || "").trim();
  if (env) return env;
  try {
    return fs.readFileSync(SHEET_URL_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || "";
  } catch (e) {
    return "";
  }
}

// Đổi đường dẫn người dùng dán vào (đường dẫn trên thanh địa chỉ / đường dẫn "Xuất bản lên web") thành đường dẫn tải CSV.
function resolveSheetUrls(raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return null;
  let u;
  try {
    u = new URL(s0);
  } catch (e) {
    return { error: "Đường dẫn Google Sheet không hợp lệ (phải bắt đầu bằng https://)." };
  }
  const gid = (s0.match(/[#?&]gid=(\d+)/) || [])[1];
  if (u.hostname === "docs.google.com") {
    const pub = u.pathname.match(/^\/spreadsheets\/d\/e\/([^/]+)/);
    if (pub) {
      const q = new URLSearchParams();
      if (gid) { q.set("gid", gid); q.set("single", "true"); }
      q.set("output", "csv");
      return { csvUrl: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?${q}`, editUrl: null };
    }
    const m = u.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
    if (m) {
      // Không có gid -> không gửi gid để Google trả về TAB ĐẦU TIÊN (gid=0 có thể không tồn tại ở Sheet nhập từ Excel)
      return {
        csvUrl: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? "&gid=" + gid : ""}`,
        editUrl: `https://docs.google.com/spreadsheets/d/${m[1]}/edit${gid ? "#gid=" + gid : ""}`,
      };
    }
  }
  if (/[?&](output|format)=csv/i.test(s0) || /\.csv(\?|$)/i.test(s0)) return { csvUrl: s0, editUrl: null }; // địa chỉ CSV khác: dùng nguyên
  return { error: "Không nhận ra đường dẫn. Hãy dán đường dẫn của Google Sheet (dạng https://docs.google.com/spreadsheets/d/...)." };
}

// Đọc CSV chuẩn RFC 4180: ô trong dấu nháy kép có thể chứa dấu phẩy, xuống dòng, và "" là 1 dấu nháy kép.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // bỏ BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Danh mục: mã/tên có sẵn -> mã (HD, LOI...); tên khác = danh mục TỰ TẠO (lấy chính tên làm mã). Trống -> KHAC.
function resolveCategoryValue(raw) {
  const t = String(raw == null ? "" : raw).replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!t) return "KHAC";
  const low = t.toLowerCase();
  const found = CATEGORIES.find((c) => c.id.toLowerCase() === low || c.label.toLowerCase() === low);
  return found ? found.id : t;
}
// Cột G "Hiển thị": để trống = hiển thị; "Không/No/False/0/Ẩn" = ẩn. Cột H "Câu hỏi gợi ý": "Có/Yes/True/1/x" = gợi ý.
const norm1 = (v) => String(v == null ? "" : v).trim().toLowerCase();
const parseVisibleFlag = (v) => !["khong", "không", "no", "false", "0", "an", "ẩn", "off", "n"].includes(norm1(v));
const parseSuggestedFlag = (v) => ["co", "có", "yes", "true", "1", "x", "y", "on", "✓", "✔"].includes(norm1(v));
function sheetRowsToEntries(rows) {
  const entries = [];
  const skipped = [];
  const warnings = [];
  const seenTitle = new Map();
  const usedIds = new Set();
  const nl = (v) => String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  const split = (v) => nl(v).split(/[\n|]/).map((x) => x.trim()).filter(Boolean);
  if (rows.length && !/cau hoi/.test(normalizeVN(rows[0][0]))) {
    warnings.push('Dòng 1 không giống dòng tiêu đề ("Câu hỏi", ...). Dòng 1 luôn được coi là tiêu đề nên không đưa vào chatbot.');
  }
  for (let idx = 1; idx < rows.length; idx++) {
    const row = rows[idx] || [];
    const rowNo = idx + 1;
    const question = nl(row[0]).trim();
    const answer = nl(row[2]).trim();
    if (!question && !answer) continue; // dòng trống
    if (!question) { skipped.push({ row: rowNo, reason: "thiếu Câu hỏi (cột A)" }); continue; }
    if (!answer) { skipped.push({ row: rowNo, reason: "chưa có Câu trả lời (cột C)", question: question.slice(0, 60) }); continue; }
    const category = resolveCategoryValue(row[1]);
    const key = question.toLowerCase().replace(/\s+/g, " ");
    if (seenTitle.has(key)) warnings.push(`Dòng ${rowNo}: câu hỏi trùng với dòng ${seenTitle.get(key)} ("${question.slice(0, 40)}"). Cả hai đều được giữ — nên xoá bớt 1 dòng.`);
    else seenTitle.set(key, rowNo);
    // id ổn định theo tiêu đề (đồng bộ lại nhiều lần vẫn giữ nguyên id)
    let id = "s" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
    for (let n = 2; usedIds.has(id); n++) id = `${id.split("-")[0]}-${n}`;
    usedIds.add(id);
    entries.push({
      id,
      title: question,
      category,
      content: answer,
      videoUrl: nl(row[3]).trim(),
      images: split(row[4]).map((u) => u.replace(/^uploads\//i, "/uploads/")),
      aliases: split(row[5]),
      visible: parseVisibleFlag(row[6]),
      suggested: parseSuggestedFlag(row[7]),
    });
  }
  return { entries, skipped: skipped.slice(0, 100), warnings: warnings.slice(0, 100) };
}

const sheetCfg = (() => {
  const raw = readSheetUrlSetting();
  if (!raw) return null;
  return { raw, ...resolveSheetUrls(raw) };
})();
const sheetMode = () => !!(sheetCfg && sheetCfg.csvUrl);
const sheetState = { lastTryAt: null, lastOkAt: null, entries: 0, skipped: [], warnings: [], error: null, syncing: false, signature: null };

function friendlySheetError(e) {
  if (e && e.sheetCode === "html") return "Google trả về trang đăng nhập thay vì dữ liệu. Hãy chia sẻ Sheet ở chế độ \"Bất kỳ ai có đường liên kết đều có thể xem\" (hoặc Tệp → Chia sẻ → Xuất bản lên web). Chatbot vẫn dùng dữ liệu đã nạp trước đó.";
  if (e && e.sheetCode === "empty") return "Không có dòng hợp lệ nào trong Sheet (cần cột A Câu hỏi và cột C Câu trả lời, dòng 1 là tiêu đề). Chatbot vẫn dùng dữ liệu đã nạp trước đó.";
  if (e && e.response) return `Google từ chối truy cập (mã ${e.response.status}). Kiểm tra lại đường dẫn và quyền chia sẻ của Sheet. Chatbot vẫn dùng dữ liệu đã nạp trước đó.`;
  if (e && /ECONNABORTED|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout/i.test(`${e.code} ${e.message}`)) return "Không kết nối được tới Google lúc này. Chatbot vẫn dùng dữ liệu đã nạp trước đó, sẽ thử lại sau.";
  return `Lỗi đồng bộ: ${(e && e.message) || e}. Chatbot vẫn dùng dữ liệu đã nạp trước đó.`;
}

let sheetSyncPromise = null;
// Chạy tuần tự: nếu đang có 1 lần đồng bộ thì chờ nó xong rồi mới chạy lần mới (để sau khi ghi vào Sheet luôn đọc được trạng thái thật).
async function syncFromSheet() {
  if (!sheetMode()) return;
  while (sheetSyncPromise) await sheetSyncPromise.catch(() => {});
  sheetSyncPromise = doSyncFromSheet();
  try { await sheetSyncPromise; } finally { sheetSyncPromise = null; }
}
async function doSyncFromSheet() {
  sheetState.syncing = true;
  sheetState.lastTryAt = new Date().toISOString();
  try {
    const r = await axios.get(sheetCfg.csvUrl, {
      timeout: SHEET_TIMEOUT_MS,
      responseType: "text",
      transformResponse: [(d) => d],
      maxContentLength: 25 * 1024 * 1024,
      headers: { Accept: "text/csv,text/plain,*/*", "User-Agent": "chatbot-sheet-sync" },
    });
    const text = String(r.data == null ? "" : r.data);
    if (/^\s*<(!doctype|html|head|body)/i.test(text) || /text\/html/i.test(String(r.headers["content-type"] || ""))) {
      const err = new Error("html"); err.sheetCode = "html"; throw err;
    }
    const { entries, skipped, warnings } = sheetRowsToEntries(parseCsv(text));
    if (entries.length === 0) { const err = new Error("empty"); err.sheetCode = "empty"; throw err; }
    const signature = crypto.createHash("sha1").update(JSON.stringify(entries)).digest("hex");
    if (signature !== sheetState.signature) {
      kb = { entries };
      writeJson(KB_FILE, kb);
      sheetState.signature = signature;
      console.log(`[sheet] Đã đồng bộ ${entries.length} mục từ Google Sheet.`);
    }
    Object.assign(sheetState, { lastOkAt: new Date().toISOString(), entries: entries.length, skipped, warnings, error: null });
  } catch (e) {
    sheetState.error = friendlySheetError(e);
    console.error("[sheet] Đồng bộ lỗi:", (e && e.sheetCode) || (e && e.message));
  } finally {
    sheetState.syncing = false;
  }
}

function sheetStatusPayload(admin) {
  const out = {
    ok: true,
    enabled: sheetMode(),
    configError: sheetCfg && sheetCfg.error ? sheetCfg.error : null,
    intervalMinutes: SHEET_SYNC_MINUTES,
    lastOkAt: sheetState.lastOkAt,
    lastTryAt: sheetState.lastTryAt,
    entries: sheetState.entries,
    error: sheetState.error,
    syncing: sheetState.syncing,
    skippedCount: sheetState.skipped.length,
    warningsCount: sheetState.warnings.length,
    writeEnabled: sheetWriteEnabled(),
    writeConfigError: sheetWriteConfigError(),
  };
  // Đường dẫn Sheet và chi tiết dòng lỗi chỉ trả cho chuyên gia (có mã quản trị), không lộ cho người dùng thường.
  if (admin && sheetCfg) Object.assign(out, { editUrl: sheetCfg.editUrl || null, sheetUrl: sheetCfg.raw, csvUrl: sheetCfg.csvUrl || null, skipped: sheetState.skipped, warnings: sheetState.warnings });
  return out;
}
app.get("/api/sheet-status", (req, res) => {
  const admin = !ADMIN_TOKEN || req.headers["x-admin-token"] === ADMIN_TOKEN;
  res.json(sheetStatusPayload(admin));
});
app.post("/api/sheet/sync", requireAdmin, async (req, res) => {
  if (!sheetMode()) return res.status(400).json({ ok: false, error: "Chưa cấu hình Google Sheet." });
  await syncFromSheet();
  res.json({ ...sheetStatusPayload(true), ok: !sheetState.error });
});

// ================= GHI NGƯỢC VÀO GOOGLE SHEET (nhập dữ liệu ngay trong chatbot) =================
// Server không có quyền ghi Sheet trực tiếp. Thay vào đó chuyên gia gắn 1 Google Apps Script vào CHÍNH Sheet đó và triển khai
// thành "ứng dụng web"; server gửi từng lệnh thêm / sửa / xoá DÒNG tới script (có mật khẩu). Hướng dẫn + mã script: xem README.
// Cấu hình: GOOGLE_SHEET_WRITE_URL (URL .../exec), GOOGLE_SHEET_WRITE_SECRET (trùng SECRET trong script), và bắt buộc ADMIN_TOKEN.
// Hoặc file google-sheet-ghi.txt: dòng 1 = URL, dòng 2 = mật khẩu.
const SHEET_WRITE_FILE = path.join(__dirname, "google-sheet-ghi.txt");
const SHEET_WRITE_TIMEOUT_MS = Number(process.env.SHEET_WRITE_TIMEOUT_MS) || 30000;
const sheetWriteCfg = (() => {
  let url = (process.env.GOOGLE_SHEET_WRITE_URL || "").trim();
  let secret = process.env.GOOGLE_SHEET_WRITE_SECRET || "";
  if (!url) {
    try {
      const lines = fs.readFileSync(SHEET_WRITE_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      url = lines[0] || "";
      if (!secret) secret = lines[1] || "";
    } catch (e) {}
  }
  return { url, secret };
})();
const sheetWriteConfigured = () => !!(sheetWriteCfg.url || sheetWriteCfg.secret);
function sheetWriteConfigError() {
  if (!sheetWriteConfigured()) return null; // không cấu hình = bình thường (chế độ chỉ-đọc)
  if (!sheetMode()) return "Muốn ghi vào Sheet, cần cấu hình GOOGLE_SHEET_URL (đường dẫn Sheet để ĐỌC) trước.";
  if (!sheetWriteCfg.url) return "Thiếu GOOGLE_SHEET_WRITE_URL (URL ứng dụng web của Apps Script, kết thúc bằng /exec).";
  if (!/^https?:\/\//i.test(sheetWriteCfg.url)) return "GOOGLE_SHEET_WRITE_URL không hợp lệ (phải bắt đầu bằng https://).";
  if (!sheetWriteCfg.secret) return "Thiếu GOOGLE_SHEET_WRITE_SECRET (mật khẩu trùng với SECRET trong Apps Script).";
  if (!ADMIN_TOKEN) return "Cần đặt biến ADMIN_TOKEN trên Render để bật ghi vào Sheet (nếu không, ai cũng sửa được tài liệu).";
  return null;
}
const sheetWriteEnabled = () => sheetWriteConfigured() && !sheetWriteConfigError();

class SheetWriteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
let sheetWriteChain = Promise.resolve();
// Chỉ cho 1 lệnh ghi chạy tại một thời điểm (tránh 2 chuyên gia ghi đè lẫn nhau trong cùng 1 phần nghìn giây)
function withSheetWriteLock(fn) {
  const run = sheetWriteChain.then(fn, fn);
  sheetWriteChain = run.catch(() => {});
  return run;
}

async function callSheetScript(payload) {
  let r;
  try {
    r = await axios.post(sheetWriteCfg.url, JSON.stringify({ secret: sheetWriteCfg.secret, ...payload }), {
      timeout: SHEET_WRITE_TIMEOUT_MS,
      responseType: "text",
      transformResponse: [(d) => d],
      maxRedirects: 5, // Google trả lời qua chuyển hướng (302) tới máy chủ khác
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  } catch (e) {
    if (e.response) throw new SheetWriteError(502, `Google Apps Script trả lỗi (mã ${e.response.status}). Dữ liệu CHƯA được ghi. Kiểm tra lại URL và cách triển khai script (Ứng dụng web, quyền truy cập "Bất kỳ ai").`);
    throw new SheetWriteError(502, "Không kết nối được tới Google Apps Script. Dữ liệu CHƯA được ghi, hãy thử lại sau.");
  }
  const text = String(r.data == null ? "" : r.data).trim();
  if (/^<(!doctype|html)/i.test(text)) throw new SheetWriteError(502, "Google trả về trang HTML thay vì kết quả (thường do script chưa triển khai đúng hoặc quyền truy cập chưa là \"Bất kỳ ai\"). Dữ liệu CHƯA được ghi.");
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new SheetWriteError(502, "Apps Script trả về dữ liệu không đọc được. Dữ liệu CHƯA được ghi — kiểm tra lại mã script theo README."); }
  if (!j || !j.ok) {
    if (j && j.error === "forbidden") throw new SheetWriteError(502, "Apps Script từ chối vì sai mật khẩu: GOOGLE_SHEET_WRITE_SECRET trên Render phải trùng SECRET trong script. Dữ liệu CHƯA được ghi.");
    throw new SheetWriteError(502, `Apps Script báo lỗi: ${String((j && j.error) || "không rõ").slice(0, 200)}. Dữ liệu CHƯA được ghi.`);
  }
  return j;
}

const titleKey = (t) => String(t == null ? "" : t).toLowerCase().replace(/\s+/g, " ").trim();
const findEntryByTitle = (entries, t) => entries.find((e) => titleKey(e.title) === titleKey(t));
function rowToEntryLocal(row) { return sheetRowsToEntries([["Câu hỏi"], row]).entries[0]; }
function applyOpsLocally(entries, ops) {
  let list = entries.map((e) => ({ ...e }));
  for (const op of ops) {
    if (op.op === "add") { const e = rowToEntryLocal(op.row); if (e) list.push(e); }
    else if (op.op === "update") { const i = list.findIndex((e) => titleKey(e.title) === titleKey(op.matchTitle)); const e = rowToEntryLocal(op.row); if (i >= 0 && e) list[i] = e; }
    else if (op.op === "delete") list = list.filter((e) => titleKey(e.title) !== titleKey(op.matchTitle));
  }
  return list;
}
function opsReflected(ops, entries) {
  return ops.every((op) => {
    if (op.op === "add") return !!findEntryByTitle(entries, op.row[0]);
    if (op.op === "update") { const e = findEntryByTitle(entries, op.row[0]); return !!e && e.content === String(op.row[2]).replace(/\r\n?/g, "\n").trim(); }
    if (op.op === "delete") return !findEntryByTitle(entries, op.matchTitle);
    return true;
  });
}

// Gửi 1 loạt lệnh tới Apps Script, rồi ĐỌC LẠI Sheet để lấy trạng thái thật. Lỗi thì ném SheetWriteError (kèm kb mới nhất).
function applySheetOps(ops) {
  return withSheetWriteLock(async () => {
    const resp = await callSheetScript({ action: "apply", ops });
    const results = Array.isArray(resp.results) ? resp.results : [];
    const OK = new Set(["added", "updated", "deleted"]);
    const okOps = ops.filter((_, i) => results[i] && OK.has(results[i].status));
    await syncFromSheet();
    // Nếu Google trả bản cũ (VD dùng đường dẫn "Xuất bản lên web" có độ trễ) thì áp tạm thay đổi để người dùng thấy ngay
    if (okOps.length && !opsReflected(okOps, kb.entries)) {
      kb = { entries: applyOpsLocally(kb.entries, okOps) };
      writeJson(KB_FILE, kb);
      sheetState.signature = null;
    }
    for (let i = 0; i < ops.length; i++) {
      const r = results[i];
      if (r && OK.has(r.status)) continue;
      const name = ops[i].row ? ops[i].row[0] : ops[i].matchTitle;
      if (r && r.status === "duplicate") throw new SheetWriteError(409, `Câu hỏi "${String(name).slice(0, 80)}" đã có trong Sheet (trùng tiêu đề). Hãy sửa mục đã có hoặc đổi tiêu đề.`);
      if (r && r.status === "not_found") throw new SheetWriteError(409, `Không tìm thấy dòng "${String(name).slice(0, 80)}" trong Sheet (có thể vừa bị sửa/xoá trực tiếp trong Sheet). Đã đồng bộ lại — hãy thử lại.`);
      throw new SheetWriteError(502, "Apps Script không xử lý được một lệnh. Đã đồng bộ lại.");
    }
    return results;
  });
}

function badRequest(msg) { const e = new SheetWriteError(400, msg); return e; }
function prepareSheetEntry(raw) {
  if (!raw || typeof raw !== "object") throw badRequest("Thiếu nội dung mục.");
  const title = String(raw.title || "").replace(/\s+/g, " ").trim();
  const content = String(raw.content || "").replace(/\r\n?/g, "\n").trim();
  if (!title || !content) throw badRequest("Cần có cả Câu hỏi và Câu trả lời.");
  if (title.length > 500) throw badRequest("Câu hỏi quá dài (tối đa 500 ký tự).");
  if (content.length > 45000) throw badRequest("Câu trả lời quá dài (Google Sheet giới hạn 50.000 ký tự mỗi ô, hãy rút gọn hoặc tách thành 2 mục).");
  const category = resolveCategoryValue(raw.category);
  const videoUrl = String(raw.videoUrl || "").replace(/\s+/g, " ").trim();
  const images = getEntryImages(raw).map((u) => String(u).trim().replace(/\|/g, "%7C").replace(/\s+/g, "%20")).filter(Boolean);
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : []).map((a) => String(a || "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const visible = raw.visible !== false;
  const suggested = visible && raw.suggested === true; // câu hỏi bị ẩn thì không thể là câu hỏi gợi ý
  return { title, row: [title, category, content, videoUrl, images.join(" | "), aliases.join(" | "), visible ? "Có" : "Không", suggested ? "Có" : ""] };
}

function requireSheetWrite(req, res, next) {
  if (!sheetMode()) return res.status(400).json({ ok: false, error: "Chưa nối Google Sheet." });
  if (!sheetWriteEnabled()) return res.status(409).json({ ok: false, sheetMode: true, error: sheetWriteConfigError() || SHEET_READONLY_MSG });
  next();
}
function sendSheetWriteError(res, err) {
  if (err instanceof SheetWriteError) return res.status(err.status).json({ ok: false, error: err.message, kb });
  console.error("[sheet-write]", err && err.message);
  res.status(500).json({ ok: false, error: "Lỗi không xác định khi ghi vào Sheet.", kb });
}
const idOfTitle = (t) => { const e = findEntryByTitle(kb.entries, t); return e ? e.id : null; };

app.post("/api/sheet/entry", requireAdmin, requireSheetWrite, async (req, res) => {
  try {
    const e = prepareSheetEntry(req.body && req.body.entry);
    await applySheetOps([{ op: "add", row: e.row }]);
    res.json({ ok: true, kb, id: idOfTitle(e.title) });
  } catch (err) { sendSheetWriteError(res, err); }
});
app.put("/api/sheet/entry/:id", requireAdmin, requireSheetWrite, async (req, res) => {
  try {
    const cur = kb.entries.find((x) => x.id === req.params.id);
    if (!cur) throw new SheetWriteError(409, "Mục này không còn trong Sheet (có thể vừa bị xoá). Danh sách đã được làm mới.");
    const e = prepareSheetEntry(req.body && req.body.entry);
    await applySheetOps([{ op: "update", matchTitle: cur.title, row: e.row }]);
    res.json({ ok: true, kb, id: idOfTitle(e.title) });
  } catch (err) { sendSheetWriteError(res, err); }
});
app.delete("/api/sheet/entry/:id", requireAdmin, requireSheetWrite, async (req, res) => {
  try {
    const cur = kb.entries.find((x) => x.id === req.params.id);
    if (!cur) throw new SheetWriteError(409, "Mục này không còn trong Sheet (có thể đã bị xoá). Danh sách đã được làm mới.");
    await applySheetOps([{ op: "delete", matchTitle: cur.title }]);
    res.json({ ok: true, kb });
  } catch (err) { sendSheetWriteError(res, err); }
});
app.post("/api/sheet/test-write", requireAdmin, requireSheetWrite, async (req, res) => {
  try {
    const j = await withSheetWriteLock(() => callSheetScript({ action: "ping" }));
    res.json({ ok: true, tab: j.tab, rows: j.rows });
  } catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message || "Không kiểm tra được." }); }
});

// Nhập hàng loạt (Excel / dán) khi đang dùng Sheet: thêm các mục MỚI vào cuối Sheet, bỏ qua mục trùng tiêu đề.
async function importIntoSheet(req, res) {
  if (!sheetWriteEnabled()) return res.status(409).json({ ok: false, sheetMode: true, error: sheetWriteConfigError() || SHEET_READONLY_MSG });
  try {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || entries.length === 0) throw badRequest("Không có dữ liệu để nhập.");
    const seen = new Set(kb.entries.map((e) => titleKey(e.title)));
    const ops = [];
    let skipped = 0;
    for (const raw of entries) {
      let p;
      try { p = prepareSheetEntry(raw); } catch (e) { skipped++; continue; }
      const k = titleKey(p.title);
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      ops.push({ op: "add", row: p.row });
    }
    let added = 0;
    for (let i = 0; i < ops.length; i += 50) {
      const chunk = ops.slice(i, i + 50);
      await applySheetOps(chunk);
      added += chunk.length;
    }
    if (ops.length === 0) await syncFromSheet();
    res.json({ ok: true, added, skipped, kb });
  } catch (err) { sendSheetWriteError(res, err); }
}

// ================= KIỂM TRA ẢNH ĐƯỢC NHẮC TỚI TRONG TÀI LIỆU CÓ FILE THẬT KHÔNG =================
// Tài liệu (nhất là khi lấy từ Google Sheet) chỉ ghi TÊN ảnh dạng "/uploads/ten.png". Nếu file ảnh chưa nằm trên server
// (chưa đưa vào public/uploads của repo, hoặc chưa nạp từ file sao lưu) thì giao diện chỉ hiện "Ảnh lỗi".
// Hàm này liệt kê chính xác ảnh nào đang thiếu để chuyên gia biết cần bổ sung gì.
function findMissingImages() {
  const refs = new Set();
  ((kb && kb.entries) || []).forEach((e) => {
    getEntryImages(e).forEach((u) => refs.add(String(u)));
    String(e.content || "").split("\n").forEach((line) => {
      const t = line.trim();
      if (/^\/?uploads\/\S+$/i.test(t)) refs.add(t);
    });
  });
  const missing = [];
  refs.forEach((u) => {
    const m = /^\/?uploads\/([^?#]+)/i.exec(u);
    if (!m) return; // link https://... không kiểm tra được từ server
    let base;
    try { base = path.basename(decodeURIComponent(m[1])); } catch (e) { base = path.basename(m[1]); }
    const onDisk = fs.existsSync(path.join(UPLOADS_DIR, base)) || fs.existsSync(path.join(__dirname, "public", "uploads", base)) || (/\.(png|jpe?g|gif|webp|svg)$/i.test(base) && fs.existsSync(path.join(__dirname, "public", base)));
    if (!onDisk) missing.push(u);
  });
  return { checked: refs.size, missing: missing.sort() };
}
app.get("/api/missing-images", requireAdmin, (req, res) => {
  res.json({ ok: true, ...findMissingImages() });
});

// ================= CƠ SỞ TRI THỨC (dùng chung) =================
// ================= TẢI ẢNH MINH HOẠ LÊN SERVER =================
app.post("/api/upload-image", requireAdmin, (req, res) => {
  if (sheetWriteEnabled()) {
    return res.status(409).json({ ok: false, sheetMode: true, error: "Đang ghi dữ liệu vào Google Sheet nên không tải ảnh lên từ máy được (ổ đĩa Render là tạm thời, ảnh sẽ mất). Hãy dán link ảnh https://… hoặc đưa file ảnh vào thư mục public/uploads trên GitHub rồi ghi /uploads/ten-anh.png." });
  }
  upload.single("image")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "Ảnh vượt quá 5MB." : err.message || "Lỗi khi tải ảnh lên.";
      return res.status(400).json({ ok: false, error: msg });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "Không nhận được file." });
    res.json({ ok: true, url: `/uploads/${req.file.filename}` });
  });
});

// Ghi lại file ảnh lên server từ dữ liệu base64 trong file sao lưu (dùng khi Khôi phục,
// vì file sao lưu chỉ có thể chứa dữ liệu ảnh, không thể tự ghi vào ổ đĩa server).
app.post("/api/restore-image", requireAdmin, (req, res) => {
  const { path: relPath, dataUrl } = req.body || {};
  if (!relPath || typeof relPath !== "string" || !relPath.startsWith("/uploads/")) {
    return res.status(400).json({ ok: false, error: "Đường dẫn ảnh không hợp lệ." });
  }
  const matches = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/.exec(dataUrl || "");
  if (!matches) return res.status(400).json({ ok: false, error: "Dữ liệu ảnh không hợp lệ." });
  const filename = path.basename(relPath); // chống path traversal, chỉ lấy tên file
  try {
    const buffer = Buffer.from(matches[1], "base64");
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
    res.json({ ok: true, url: `/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Không ghi được file ảnh lên server." });
  }
});

app.get("/api/kb", (req, res) => {
  res.json(kb);
});

// Ghi đè toàn bộ danh sách (dùng khi thêm/xoá 1 mục từ giao diện)
// Cho giao diện (tab Cài đặt) biết server vừa tự nạp lại dữ liệu từ file sao lưu trong GitHub hay chưa.
app.get("/api/seed-status", (req, res) => {
  res.json({ ok: true, ...seedStatus });
});

app.put("/api/kb", requireAdmin, (req, res) => {
  if (sheetMode()) return res.status(409).json({ ok: false, sheetMode: true, error: sheetWriteEnabled() ? "Đang ghi dữ liệu vào Google Sheet: hãy thêm / sửa / xoá từng mục trong trang quản trị (không ghi đè cả danh sách)." : SHEET_READONLY_MSG });
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ ok: false, error: "Thiếu entries" });
  kb = { entries };
  writeJson(KB_FILE, kb);
  res.json({ ok: true, kb });
});

// Nhập hàng loạt (dán tay hoặc từ Excel) — nối thêm vào danh sách hiện có
app.post("/api/kb/import", requireAdmin, async (req, res) => {
  if (sheetMode()) return importIntoSheet(req, res); // đang dùng Google Sheet: ghi từng mục mới vào Sheet (hoặc báo chỉ-đọc)
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ ok: false, error: "Không có dữ liệu để nhập." });
  }
  const withIds = entries.map((e, i) => ({
    id: `import-${Date.now()}-${i}`,
    title: String(e.title || "").trim(),
    category: e.category || "KHAC",
    content: String(e.content || "").trim(),
    videoUrl: String(e.videoUrl || "").trim(),
    images: Array.isArray(e.images) ? e.images.map((u) => String(u || "").trim()).filter(Boolean) : [],
    aliases: Array.isArray(e.aliases) ? e.aliases.map((a) => String(a || "").trim()).filter(Boolean) : [],
    visible: e.visible !== false,
    suggested: e.suggested === true,
  }));
  kb = { entries: [...withIds, ...kb.entries] };
  writeJson(KB_FILE, kb);
  res.json({ ok: true, added: withIds.length, kb });
});

// AI gợi ý "cách hỏi khác" (alias) dựa trên câu hỏi + câu trả lời chuyên gia vừa nhập.
// Dùng model rẻ (Haiku) vì đây là tác vụ đơn giản, không cần suy luận phức tạp.
app.post("/api/suggest-aliases", requireAdmin, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ ok: false, error: "Thiếu câu hỏi hoặc câu trả lời." });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server chưa cấu hình ANTHROPIC_API_KEY." });
  }

  const prompt = `Đây là 1 mục trong tài liệu hướng dẫn của phần mềm hành chính công (đánh giá công chức):
Câu hỏi: ${title}
Câu trả lời: ${String(content).slice(0, 1500)}

Hãy nghĩ ra 3 CÁCH HỎI KHÁC cho cùng câu hỏi trên — cách một công chức bình thường (không rành công nghệ) có thể gõ để hỏi đúng nội dung này. Yêu cầu:
- Ngắn gọn, tự nhiên, khẩu ngữ, KHÔNG lặp lại y nguyên câu hỏi gốc.
- Mỗi cách hỏi là 1 câu độc lập, không đánh số, không giải thích thêm.
- Chỉ trả lời bằng đúng 1 mảng JSON chứa 3 chuỗi tiếng Việt, không có bất kỳ chữ nào khác trước/sau. Ví dụ: ["câu 1","câu 2","câu 3"]`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }
    );
    const rawText = (response.data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    let aliases = [];
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) aliases = parsed.map((a) => String(a || "").trim()).filter(Boolean);
    } catch (parseErr) {
      return res.status(500).json({ ok: false, error: "AI trả lời sai định dạng, thử lại lần nữa xem sao." });
    }
    res.json({ ok: true, aliases });
  } catch (err) {
    const anthropicError = err.response?.data?.error;
    console.error(anthropicError || err.message);
    let detail = "";
    if (anthropicError?.type === "authentication_error") detail = " (Sai hoặc thiếu ANTHROPIC_API_KEY.)";
    else if (anthropicError?.type === "rate_limit_error") detail = " (Vượt giới hạn tốc độ API key, thử lại sau ít phút.)";
    else if (anthropicError?.message) detail = ` (${anthropicError.message})`;
    res.status(500).json({ ok: false, error: `Lỗi khi gọi AI gợi ý.${detail}` });
  }
});
app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.put("/api/settings", requireAdmin, (req, res) => {
  const { greeting, expertEmail, noResultMessage, customCategories } = req.body;
  settings = {
    ...settings,
    greeting: greeting !== undefined ? greeting : settings.greeting,
    expertEmail: expertEmail !== undefined ? expertEmail : settings.expertEmail,
    noResultMessage: noResultMessage !== undefined ? String(noResultMessage).slice(0, 2000) : settings.noResultMessage,
    // Danh mục tự tạo (chỉ cần giữ danh mục CHƯA có câu hỏi nào; danh mục đã có câu hỏi tự suy ra từ dữ liệu)
    customCategories: Array.isArray(customCategories)
      ? [...new Set(customCategories.map((c) => String(c || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)).filter(Boolean))].slice(0, 100)
      : settings.customCategories,
  };
  writeJson(SETTINGS_FILE, settings);
  res.json({ ok: true, settings });
});

// ================= NHẬT KÝ CÂU HỎI CHUYỂN CHUYÊN GIA =================
app.get("/api/escalations", (req, res) => {
  res.json(escalations);
});

app.delete("/api/escalations/:id", requireAdmin, (req, res) => {
  escalations = escalations.filter((t) => t.id !== req.params.id);
  writeJson(ESCALATIONS_FILE, escalations);
  res.json({ ok: true });
});

// ================= CHAT — gọi Claude API trực tiếp từ server =================
app.post("/api/chat", async (req, res) => {
  const { history } = req.body; // [{role: 'user'|'assistant', text: '...'}]
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ ok: false, error: "Thiếu nội dung hội thoại." });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server chưa cấu hình ANTHROPIC_API_KEY." });
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const toAbsolute = (url) => (url && url.startsWith("/") ? `${origin}${url}` : url);

  const kbText = kb.entries
    .filter((e) => e.visible !== false) // câu hỏi đã tắt "Hiển thị" thì không dùng để trả lời
    .map((e, i) => {
      let block = `[Mục ${i + 1}] Câu hỏi: ${e.title}\nDanh mục: ${getCategoryLabel(e.category)}\nCâu trả lời: ${e.content}`;
      if (Array.isArray(e.aliases) && e.aliases.length > 0) block += `\nCách hỏi khác cho mục này: ${e.aliases.join(" | ")}`;
      if (e.videoUrl) block += `\nVideo hướng dẫn: ${toAbsolute(e.videoUrl)}`;
      const images = getGalleryImages(e);
      images.forEach((img, idx) => {
        block += `\nHình ảnh minh hoạ ${idx + 1}: ${toAbsolute(img)}`;
      });
      return block;
    })
    .join("\n\n");

  const systemPrompt = `Bạn là trợ lý hỗ trợ người dùng phần mềm. Chỉ trả lời dựa trên tài liệu hướng dẫn dưới đây, tuyệt đối không bịa thông tin.

Nếu mục tài liệu bạn dùng để trả lời có kèm "Video hướng dẫn" hoặc "Hình ảnh minh hoạ", hãy thêm nguyên văn (dòng chữ và link URL đó) vào câu trả lời để người dùng xem thêm — nếu câu trả lời có nhiều bước và có nhiều ảnh minh hoạ tương ứng từng bước, hãy đặt mỗi link ảnh trên 1 dòng riêng, ngay sau bước mà nó minh hoạ (không dồn hết ảnh xuống cuối), để người dùng dễ theo dõi. Không tự thêm link nếu mục đó không có.

Trả lời ngắn gọn, rõ ràng, theo từng bước nếu là hướng dẫn thao tác. Trả lời bằng tiếng Việt.

QUAN TRỌNG: Nếu câu hỏi KHÔNG có trong tài liệu hướng dẫn bên dưới, hoặc bạn không đủ cơ sở để trả lời chính xác, hãy:
1. Trả lời trung thực rằng bạn chưa có thông tin về vấn đề này.
2. Thêm CHÍNH XÁC chuỗi "${ESCALATION_MARKER}" vào cuối câu trả lời, không thêm bất kỳ ký tự nào khác sau chuỗi đó.
Ngược lại, nếu tài liệu có đủ thông tin để trả lời, TUYỆT ĐỐI KHÔNG thêm chuỗi đó.

=== TÀI LIỆU HƯỚNG DẪN ===
${kbText || "(Chưa có tài liệu nào được nạp.)"}
=== HẾT TÀI LIỆU ===`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-5",
        max_tokens: 1000,
        system: systemPrompt,
        messages: history.map((m) => ({ role: m.role, content: m.text })),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }
    );

    const rawText =
      (response.data.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n") || "Xin lỗi, tôi chưa thể trả lời câu hỏi này.";

    const needsEscalation = rawText.includes(ESCALATION_MARKER);
    const cleanText = rawText.replace(ESCALATION_MARKER, "").trim();

    // Tự động ghi nhận câu hỏi chatbot chưa đáp ứng được (không ảnh hưởng gì tới câu trả lời trả về).
    try {
      const lastUser = [...history].reverse().find((m) => m && m.role === "user" && typeof m.text === "string");
      const ctx = ["nomatch", "ambiguous", "kb"].includes(req.body.context) ? req.body.context : null;
      // Không biết ngữ cảnh mà AI trả lời bình thường -> không coi là "chưa trả lời được".
      if (lastUser && (ctx || needsEscalation) && allowEvent(req)) {
        logUnanswered({
          question: lastUser.text,
          trigger: ctx === "ambiguous" ? "ambiguous" : ctx === "kb" ? "kb_dislike" : null,
          outcome: needsEscalation ? "ai_unknown" : "ai_answered",
          draft: needsEscalation ? null : cleanText,
          nearTitles: Array.isArray(req.body.shownTitles) ? req.body.shownTitles : [],
        });
      }
    } catch (e) {
      console.error("[unanswered] Lỗi ghi nhận:", e.message);
    }

    res.json({ ok: true, text: cleanText, needsEscalation });
  } catch (err) {
    const anthropicError = err.response?.data?.error;
    console.error(anthropicError || err.message);
    let detail = "";
    if (anthropicError?.type === "authentication_error") {
      detail = " (Sai hoặc thiếu ANTHROPIC_API_KEY — kiểm tra lại biến môi trường trên Render.)";
    } else if (anthropicError?.type === "not_found_error") {
      detail = " (Tên model không tồn tại — kiểm tra lại dòng model trong server.js.)";
    } else if (anthropicError?.type === "rate_limit_error") {
      detail = " (Đã vượt giới hạn tốc độ/hạn mức của API key — thử lại sau ít phút.)";
    } else if (anthropicError?.message) {
      detail = ` (${anthropicError.message})`;
    }
    res.status(500).json({ ok: false, error: `Lỗi khi gọi Claude API.${detail}` });
  }
});

// ================= ZALO OA: OAuth, webhook, gửi tin cho chuyên gia =================
const pendingAuth = new Map();
function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

app.get("/oauth/start", (req, res) => {
  if (!ZALO_APP_ID || !ZALO_CALLBACK_URL) {
    return res.status(400).send("Chưa cấu hình ZALO_APP_ID / ZALO_CALLBACK_URL trong .env");
  }
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(8));
  pendingAuth.set(state, codeVerifier);

  const url =
    `https://oauth.zaloapp.com/v4/oa/permission` +
    `?app_id=${encodeURIComponent(ZALO_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(ZALO_CALLBACK_URL)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const codeVerifier = pendingAuth.get(state);
  if (!code || !codeVerifier) {
    return res.status(400).send("Thiếu code hoặc state không hợp lệ. Thử lại từ /oauth/start.");
  }
  pendingAuth.delete(state);

  try {
    const response = await axios.post(
      "https://oauth.zaloapp.com/v4/oa/access_token",
      new URLSearchParams({
        app_id: ZALO_APP_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: ZALO_APP_SECRET } }
    );
    zaloTokens = { ...response.data, obtained_at: Date.now() };
    writeJson(TOKEN_FILE, zaloTokens);
    res.send("✅ Đã lấy access_token Zalo OA thành công. Bạn có thể đóng tab này.");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Lỗi khi đổi code lấy access_token.");
  }
});

async function refreshZaloToken() {
  if (!zaloTokens?.refresh_token) return;
  try {
    const response = await axios.post(
      "https://oauth.zaloapp.com/v4/oa/access_token",
      new URLSearchParams({
        app_id: ZALO_APP_ID,
        grant_type: "refresh_token",
        refresh_token: zaloTokens.refresh_token,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: ZALO_APP_SECRET } }
    );
    zaloTokens = { ...zaloTokens, ...response.data, obtained_at: Date.now() };
    writeJson(TOKEN_FILE, zaloTokens);
    console.log("🔄 Đã làm mới Zalo access_token lúc", new Date().toLocaleString("vi-VN"));
  } catch (err) {
    console.error("Lỗi làm mới Zalo token:", err.response?.data || err.message);
  }
}

async function getValidZaloToken() {
  if (!zaloTokens) throw new Error("Chưa có access_token Zalo. Hãy chạy /oauth/start trước.");
  const ageSeconds = (Date.now() - zaloTokens.obtained_at) / 1000;
  const expiresIn = Number(zaloTokens.expires_in || 3600);
  if (ageSeconds > expiresIn - 300) await refreshZaloToken();
  return zaloTokens.access_token;
}

app.post("/webhook", (req, res) => {
  const event = req.body;
  const senderId = event?.sender?.id;
  if (senderId) {
    zaloConfig.recentSenders = [
      { user_id: senderId, at: new Date().toISOString() },
      ...(zaloConfig.recentSenders || []).filter((s) => s.user_id !== senderId),
    ].slice(0, 20);
    writeJson(ZALO_CONFIG_FILE, zaloConfig);
  }
  res.sendStatus(200);
});

app.get("/admin/recent-senders", requireAdmin, (req, res) => {
  res.json(zaloConfig.recentSenders || []);
});

app.put("/admin/expert", requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Thiếu userId" });
  zaloConfig.expertUserId = userId;
  writeJson(ZALO_CONFIG_FILE, zaloConfig);
  res.json({ ok: true, expertUserId: userId });
});

app.get("/admin/expert", requireAdmin, (req, res) => {
  res.json({ expertUserId: zaloConfig.expertUserId || null });
});

// Frontend gọi vào đây khi cần chuyển câu hỏi cho chuyên gia (qua Zalo, có fallback lưu log)
app.post("/api/escalate", async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ ok: false, error: "Thiếu nội dung câu hỏi." });
  }

  const ticket = { id: `${Date.now()}`, question, timestamp: new Date().toISOString(), sentVia: "chưa gửi được" };
  if (allowEvent(req)) logUnanswered({ question, outcome: "escalated" });

  let sentVia = null;
  let errorText = "";

  if (zaloConfig.expertUserId && zaloTokens) {
    try {
      const accessToken = await getValidZaloToken();
      const response = await axios.post(
        "https://openapi.zalo.me/v3.0/oa/message/cs",
        {
          recipient: { user_id: zaloConfig.expertUserId },
          message: { text: `🔔 Chatbot chưa trả lời được câu hỏi sau, cần chuyên gia hỗ trợ:\n\n"${question}"` },
        },
        { headers: { "Content-Type": "application/json", access_token: accessToken } }
      );
      if (!response.data?.error || response.data.error === 0) {
        sentVia = "zalo";
      } else {
        errorText = response.data.message || "Lỗi gửi Zalo.";
      }
    } catch (err) {
      errorText = "Không gửi được qua Zalo.";
    }
  }

  ticket.sentVia = sentVia || "chưa gửi được";
  escalations = [ticket, ...escalations];
  writeJson(ESCALATIONS_FILE, escalations);

  res.json({ ok: !!sentVia, sentVia, error: sentVia ? undefined : errorText || "Chưa cấu hình Zalo OA cho chuyên gia." });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  if (sheetCfg && sheetCfg.error) console.error("[sheet] Cấu hình Google Sheet sai:", sheetCfg.error);
  if (sheetMode()) {
    console.log(`[sheet] Dùng Google Sheet làm nơi chứa tài liệu (tự đồng bộ mỗi ${SHEET_SYNC_MINUTES} phút).`);
    syncFromSheet(); // chạy nền ngay khi khởi động
    setInterval(syncFromSheet, SHEET_SYNC_MINUTES * 60000).unref();
  }
  if (unanswered.length) console.log(`[unanswered] Đang có ${unanswered.length} câu hỏi chưa trả lời được ghi nhận.`);
  console.log(`🚀 Website chatbot hỗ trợ đang chạy tại http://localhost:${PORT}`);
  setInterval(async () => {
    if (!zaloTokens) return;
    const ageSeconds = (Date.now() - zaloTokens.obtained_at) / 1000;
    const expiresIn = Number(zaloTokens.expires_in || 3600);
    if (ageSeconds > expiresIn - 600) await refreshZaloToken();
  }, 5 * 60 * 1000);
});
