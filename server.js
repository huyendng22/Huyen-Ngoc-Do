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

const DEFAULT_GREETING =
  "Chào bạn, tôi là chatbot hỗ trợ phần mềm. Hãy đặt câu hỏi, tôi sẽ trả lời dựa trên tài liệu hướng dẫn đã được nạp.";
const ESCALATION_MARKER = "[CẦN_CHUYÊN_GIA]";

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
let settings = readJson(SETTINGS_FILE, { greeting: DEFAULT_GREETING, expertEmail: "" });
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

// ================= CƠ SỞ TRI THỨC (dùng chung) =================
// ================= TẢI ẢNH MINH HOẠ LÊN SERVER =================
app.post("/api/upload-image", requireAdmin, (req, res) => {
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
app.put("/api/kb", requireAdmin, (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ ok: false, error: "Thiếu entries" });
  kb = { entries };
  writeJson(KB_FILE, kb);
  res.json({ ok: true, kb });
});

// Nhập hàng loạt (dán tay hoặc từ Excel) — nối thêm vào danh sách hiện có
app.post("/api/kb/import", requireAdmin, (req, res) => {
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
  }));
  kb = { entries: [...withIds, ...kb.entries] };
  writeJson(KB_FILE, kb);
  res.json({ ok: true, added: withIds.length, kb });
});

// ================= CÀI ĐẶT (dùng chung) =================
app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.put("/api/settings", requireAdmin, (req, res) => {
  const { greeting, expertEmail } = req.body;
  settings = {
    greeting: greeting !== undefined ? greeting : settings.greeting,
    expertEmail: expertEmail !== undefined ? expertEmail : settings.expertEmail,
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
    .map((e, i) => {
      let block = `[Mục ${i + 1}] Câu hỏi: ${e.title}\nDanh mục: ${getCategoryLabel(e.category)}\nCâu trả lời: ${e.content}`;
      if (Array.isArray(e.aliases) && e.aliases.length > 0) block += `\nCách hỏi khác cho mục này: ${e.aliases.join(" | ")}`;
      if (e.videoUrl) block += `\nVideo hướng dẫn: ${toAbsolute(e.videoUrl)}`;
      const images = getEntryImages(e);
      images.forEach((img, idx) => {
        block += `\nHình ảnh minh hoạ ${idx + 1}: ${toAbsolute(img)}`;
      });
      return block;
    })
    .join("\n\n");

  const systemPrompt = `Bạn là trợ lý hỗ trợ người dùng phần mềm. Chỉ trả lời dựa trên tài liệu hướng dẫn dưới đây, tuyệt đối không bịa thông tin.

Nếu mục tài liệu bạn dùng để trả lời có kèm "Video hướng dẫn" hoặc "Hình ảnh minh hoạ", hãy thêm nguyên văn (dòng chữ và link URL đó) vào cuối câu trả lời để người dùng xem thêm. Không tự thêm link nếu mục đó không có.

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
  console.log(`🚀 Website chatbot hỗ trợ đang chạy tại http://localhost:${PORT}`);
  setInterval(async () => {
    if (!zaloTokens) return;
    const ageSeconds = (Date.now() - zaloTokens.obtained_at) / 1000;
    const expiresIn = Number(zaloTokens.expires_in || 3600);
    if (ageSeconds > expiresIn - 600) await refreshZaloToken();
  }, 5 * 60 * 1000);
});
