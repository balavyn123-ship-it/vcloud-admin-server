/**
 * VclouD ↔ Odoo Community Edition — синхронізація товарів
 * 
 * Використовує Odoo JSON-RPC API (працює з коробки в Odoo CE).
 * Конфігурація — через env змінні в Render:
 *   ODOO_URL       = https://your-odoo.com
 *   ODOO_DB        = your_database
 *   ODOO_USER      = admin
 *   ODOO_API_KEY   = your_api_key_or_password
 */

const fetch = require("node-fetch");

// ─── Конфіг (env) ───────────────────────────────────────────────
const ODOO_URL     = process.env.ODOO_URL     || "";  // https://your-odoo.com
const ODOO_DB      = process.env.ODOO_DB      || "";  // database name
const ODOO_USER    = process.env.ODOO_USER    || "";  // login (email)
const ODOO_API_KEY = process.env.ODOO_API_KEY || "";  // API key або password

// ─── JSON-RPC виклик ────────────────────────────────────────────
let _uid = null;

async function jsonRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      id: Date.now(),
      params
    }),
    timeout: 15000
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.data?.message || data.error.message || JSON.stringify(data.error);
    throw new Error(`Odoo RPC: ${msg}`);
  }
  return data.result;
}

// ─── Аутентифікація ─────────────────────────────────────────────
async function authenticate() {
  if (_uid) return _uid;
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY) {
    throw new Error("Odoo не налаштований — задайте ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY в Render");
  }
  _uid = await jsonRpc(`${ODOO_URL}/jsonrpc`, "call", {
    service: "common",
    method:  "authenticate",
    args:    [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]
  });
  if (!_uid) throw new Error("Odoo: невірний логін або API ключ");
  console.log(`✅ Odoo authenticated: uid=${_uid}`);
  return _uid;
}

// ─── Виклик Odoo моделі (object.execute_kw) ────────────────────
async function call(model, method, args = [], kwargs = {}) {
  const uid = await authenticate();
  return jsonRpc(`${ODOO_URL}/jsonrpc`, "call", {
    service: "object",
    method:  "execute_kw",
    args:    [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]
  });
}

// ─── Категорії Odoo → категорії сайту ───────────────────────────
const CATEGORY_MAP = {
  // Odoo categ name (lowercase) → ваша категорія
  // Налаштуйте під свої категорії в Odoo
  "одяг":         "clothing",
  "одежда":       "clothing",
  "clothing":     "clothing",
  "жіночий одяг": "clothing",
  "чоловічий одяг": "clothing",
  "взуття":       "shoes",
  "обувь":        "shoes",
  "shoes":        "shoes",
  "електроніка":  "electronics",
  "электроника":  "electronics",
  "electronics":  "electronics",
  "телефони":     "electronics",
  "аксесуари":    "accessories",
  "accessories":  "accessories",
  "косметика":    "cosmetics",
  "cosmetics":    "cosmetics",
};

function mapCategory(odooCategoryName) {
  if (!odooCategoryName) return "other";
  const lower = odooCategoryName.toLowerCase().trim();
  // Шукаємо точний збіг
  if (CATEGORY_MAP[lower]) return CATEGORY_MAP[lower];
  // Шукаємо часткову відповідність
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return "other";
}

// ─── Валюта Odoo → наша валюта ──────────────────────────────────
function mapCurrency(odooCurrencyName) {
  if (!odooCurrencyName) return "UAH";
  const upper = odooCurrencyName.toUpperCase().trim();
  if (["UAH", "ГРН"].includes(upper)) return "UAH";
  if (["USD", "ДОЛ"].includes(upper)) return "USD";
  if (["EUR", "ЄВР"].includes(upper)) return "EUR";
  return "UAH";
}

// ─── Отримати зображення товару з Odoo ──────────────────────────
function getOdooImageUrl(productId) {
  if (!ODOO_URL || !productId) return null;
  // Odoo зберігає image_1920 як base64, але є публічний URL для зображень:
  return `${ODOO_URL}/web/image/product.template/${productId}/image_1920`;
}

// ─── Головна функція: отримати товари з Odoo ────────────────────
async function fetchOdooProducts(options = {}) {
  const {
    limit   = 500,   // максимум товарів
    onlyActive = true,
    updatedAfter = null  // ISO date string — тільки оновлені після цієї дати
  } = options;

  // Фільтр
  const domain = [];
  if (onlyActive) domain.push(["active", "=", true], ["sale_ok", "=", true]);
  if (updatedAfter) domain.push(["write_date", ">=", updatedAfter]);

  // Поля які тягнемо з Odoo
  const fields = [
    "id", "name", "list_price", "default_code",    // назва, ціна, артикул
    "categ_id", "description_sale", "description",  // категорія, опис
    "qty_available", "virtual_available",            // залишки
    "currency_id", "barcode",                        // валюта, штрихкод
    "image_1920", "active", "sale_ok",               // зображення, статус
    "write_date"                                     // дата оновлення
  ];

  console.log(`📡 Odoo: fetching products (limit=${limit})...`);

  const products = await call("product.template", "search_read", [domain], {
    fields,
    limit,
    order: "write_date desc"
  });

  console.log(`📦 Odoo: отримано ${products.length} товарів`);

  // Трансформуємо в наш формат
  return products.map(p => {
    // Odoo повертає categ_id як [id, "Name"]
    const categName = Array.isArray(p.categ_id) ? p.categ_id[1] : "";
    const currName  = Array.isArray(p.currency_id) ? p.currency_id[1] : "";

    // Зображення: якщо в Odoo є image_1920 — генеруємо URL
    const hasImage = p.image_1920 && p.image_1920 !== false;
    const odooImage = hasImage ? getOdooImageUrl(p.id) : null;

    return {
      odoo_id:      p.id,
      title:        p.name || "",
      price:        Number(p.list_price) || 0,
      currency:     mapCurrency(currName),
      category:     mapCategory(categName),
      description:  p.description_sale || p.description || p.name || "",
      sku:          p.default_code || "",
      barcode:      p.barcode || "",
      stock:        p.qty_available != null ? Math.max(0, Math.round(p.qty_available)) : null,
      image:        odooImage,   // може бути null — тоді сервер шукатиме фото
      images:       odooImage ? [odooImage] : [],
      active:       p.active !== false && p.sale_ok !== false,
      write_date:   p.write_date || null
    };
  });
}

// ─── Перевірка з'єднання ────────────────────────────────────────
async function testConnection() {
  try {
    const uid = await authenticate();
    const version = await jsonRpc(`${ODOO_URL}/jsonrpc`, "call", {
      service: "common",
      method:  "version",
      args:    []
    });
    return {
      ok: true,
      uid,
      server_version: version?.server_version || "unknown",
      url: ODOO_URL,
      db: ODOO_DB
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Чи налаштований Odoo ───────────────────────────────────────
function isConfigured() {
  return !!(ODOO_URL && ODOO_DB && ODOO_USER && ODOO_API_KEY);
}

module.exports = {
  fetchOdooProducts,
  testConnection,
  isConfigured,
  mapCategory,
  mapCurrency,
  authenticate
};
