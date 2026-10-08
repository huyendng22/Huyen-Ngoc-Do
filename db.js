/**
 * Lớp lưu trữ dữ liệu.
 *  - Có biến môi trường DATABASE_URL  -> lưu vào Postgres (bền vững, không mất khi Render ngủ/deploy lại)
 *  - Không có DATABASE_URL            -> lưu file trong thư mục /data như cũ (chỉ dùng khi chạy thử trên máy)
 */
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
const useDb = !!DATABASE_URL;
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

let pool = null;

async function init() {
  if (useDb) {
    const { Pool } = require("pg");
    const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS images (
      filename TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    console.log("🗄️  Đang dùng Postgres để lưu dữ liệu (bền vững).");
  } else {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.warn("⚠️  Chưa có DATABASE_URL — đang lưu bằng file trên đĩa. Trên Render gói Free, dữ liệu sẽ MẤT khi server khởi động lại.");
  }
}

async function getJson(key, fallback) {
  if (useDb) {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
    return r.rows.length ? r.rows[0].value : fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${key}.json`), "utf8"));
  } catch (e) {
    return fallback;
  }
}

async function setJson(key, data) {
  if (useDb) {
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(data)]
    );
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, `${key}.json`), JSON.stringify(data, null, 2));
}

async function saveImage(filename, mime, buffer) {
  if (useDb) {
    await pool.query(
      `INSERT INTO images (filename, mime, data) VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
      [filename, mime, buffer]
    );
    return;
  }
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
}

async function getImage(filename) {
  if (useDb) {
    const r = await pool.query("SELECT mime, data FROM images WHERE filename = $1", [filename]);
    return r.rows.length ? { mime: r.rows[0].mime, data: r.rows[0].data } : null;
  }
  try {
    const data = fs.readFileSync(path.join(UPLOADS_DIR, filename));
    return { mime: MIME_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream", data };
  } catch (e) {
    return null;
  }
}

module.exports = { init, getJson, setJson, saveImage, getImage, useDb };
