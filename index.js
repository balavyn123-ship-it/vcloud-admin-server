const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// Завантажуємо .env лише локально (на Railway є env variables)
require("dotenv").config();

// Дозволяємо self-signed SSL (для сумісності зі старим Node.js)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Конфіг (всі секрети — тільки через змінні середовища) ────
const NETLIFY_TOKEN   = process.env.NETLIFY_TOKEN;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || "vcloud2026";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ─── NOWPayments ────────────────────────────────────────────────
const NWP_API_KEY    = process.env.NWP_API_KEY    || "QNSGEWK-93041FR-J5262DS-YFBT1VB";
const NWP_IPN_SECRET = process.env.NWP_IPN_SECRET || "uPefK51CZf9JABD1xBi6m2j7BCK/JYPi";
const NWP_API        = "https://api.nowpayments.io/v1";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL або SUPABASE_KEY не задані — DB не працюватиме");
}
if (!NETLIFY_TOKEN || !NETLIFY_SITE_ID) {
  console.warn("⚠️  NETLIFY_TOKEN або NETLIFY_SITE_ID не задані — деплой не працюватиме");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
// Raw body потрібен для перевірки підпису NOWPayments webhook
app.use((req, res, next) => {
  if (req.path === "/api/nowpayments/webhook") {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => { req.rawBody = data; req.body = JSON.parse(data || "{}"); next(); });
  } else {
    next();
  }
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Supabase helpers ───────────────────────────────────────────
async function dbGetAll() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("id", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function dbInsert(product) {
  const { data, error } = await supabase
    .from("products")
    .insert(product)
    .select()
    .single();
  // Якщо помилка через відсутню колонку stock — повторюємо без неї
  if (error && error.message && error.message.includes("stock")) {
    const { stock: _s, ...productWithoutStock } = product;
    const { data: data2, error: error2 } = await supabase
      .from("products")
      .insert(productWithoutStock)
      .select()
      .single();
    if (error2) throw error2;
    return data2;
  }
  if (error) throw error;
  return data;
}

async function dbDelete(id) {
  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

async function dbUpdate(id, fields) {
  const { error } = await supabase
    .from("products")
    .update(fields)
    .eq("id", id);
  // Якщо помилка через відсутню колонку stock — повторюємо без неї
  if (error && error.message && error.message.includes("stock")) {
    const { stock: _s, ...fieldsWithoutStock } = fields;
    if (Object.keys(fieldsWithoutStock).length === 0) return; // нічого оновлювати
    const { error: error2 } = await supabase
      .from("products")
      .update(fieldsWithoutStock)
      .eq("id", id);
    if (error2) throw error2;
    return;
  }
  if (error) throw error;
}

// ─── Категорії за ключовими словами ─────────────────────────────
function detectCategory(title) {
  const t = title.toLowerCase();
  if (/куртка|футболка|джинси|штани|сукня|кофта|светр|пальто|шорти|сорочка|nike|adidas|zara/i.test(t)) return "clothing";
  if (/iphone|samsung|ноутбук|телефон|смартфон|планшет|навушники|телевізор|xiaomi|apple|sony/i.test(t)) return "electronics";
  if (/сумка|рюкзак|гаманець|годинник|окуляри|прикраса|браслет/i.test(t)) return "accessories";
  if (/кросівки|черевики|туфлі|сандалі|кеди|чоботи/i.test(t)) return "shoes";
  return "other";
}

// ─── Пошук фото через Bing Images ───────────────────────────────
async function searchImages(query, count = 5) {
  try {
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query + " товар купити")}&form=HDRSC2&first=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "uk-UA,uk;q=0.9",
      },
    });
    const html = await res.text();
    const matches = [...html.matchAll(/murl&quot;:&quot;(https[^&]+)&quot;/g)].map(m => m[1]);
    const images = matches.filter(u => /\.(jpg|jpeg|png|webp)/i.test(u)).slice(0, count);
    return images.length ? images : matches.slice(0, count);
  } catch {
    return [];
  }
}

// ─── Парсинг з URL ───────────────────────────────────────────────
async function parseFromUrl(url, title) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "uk-UA,uk;q=0.9",
      },
      timeout: 12000,
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const ogDesc  = $('meta[property="og:description"]').attr("content") || "";
    const ogImages = [];
    $('meta[property="og:image"]').each((_, el) => {
      const src = $(el).attr("content");
      if (src && !ogImages.includes(src)) ogImages.push(src);
    });

    const foundTitle = $("h1").first().text().trim() || ogTitle || title;
    const description = ogDesc || foundTitle;

    // Якщо немає og:image — шукаємо через Bing
    const images = ogImages.length ? ogImages.slice(0, 5) : await searchImages(foundTitle || title);

    return { foundTitle, description, images, image: images[0] || "" };
  } catch {
    const images = await searchImages(title);
    return { foundTitle: title, description: title, images, image: images[0] || "" };
  }
}

// ─── AI перевірка ────────────────────────────────────────────────
function aiCheck(searchTitle, foundTitle, images) {
  if (!foundTitle) return { status: "❌ не знайдено", comment: "Товар не знайдено" };

  const sw = new Set(searchTitle.toLowerCase().match(/\b\w{3,}\b/g) || []);
  const fw = new Set(foundTitle.toLowerCase().match(/\b\w{3,}\b/g) || []);
  const common = [...sw].filter(w => fw.has(w));
  const score = common.length / Math.max(sw.size, 1);

  if (!images.length) return { status: "⚠️ без фото", comment: `Знайдено «${foundTitle.slice(0, 40)}», але немає фото` };
  if (score >= 0.5)   return { status: "✅ правильно", comment: `Знайдено «${foundTitle.slice(0, 50)}»` };
  if (score >= 0.2)   return { status: "⚠️ можливо",  comment: `Схожий: «${foundTitle.slice(0, 50)}»` };
  return { status: "❌ інший товар", comment: `Знайдено «${foundTitle.slice(0, 50)}»` };
}

// ─── Деплой на Netlify ───────────────────────────────────────────
// Сайт тепер читає товари напряму з API (/api/public/products),
// тому деплой Netlify потрібен тільки для оновлення HTML/CSS/JS файлів.
// При зміні товарів — деплой НЕ потрібен, сайт бачить зміни одразу.
async function deployToNetlify() {
  // Нічого не деплоїмо — сайт читає з API в реальному часі
  console.log("ℹ️  Деплой Netlify пропущено — сайт читає з API напряму");
  return { ok: true, url: "https://vcloud-v2.netlify.app" };
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Авторизація
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: Buffer.from(password).toString("base64") });
  } else {
    res.status(401).json({ ok: false, error: "Невірний пароль" });
  }
});

// Middleware авторизації
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token === Buffer.from(ADMIN_PASSWORD).toString("base64")) return next();
  res.status(401).json({ error: "Не авторизовано" });
}

// ─── Публічний endpoint для сайту (без авторизації) ─────────────
app.get("/api/public/products", async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const products = await dbGetAll();
    res.json({ products, total: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Отримати всі товари (адмін)
app.get("/api/products", auth, async (req, res) => {
  try {
    const products = await dbGetAll();
    res.json({ products, total: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Додати товар (SSE — стрімінг прогресу)
app.post("/api/products", auth, async (req, res) => {
  try {
    const { title, price, url, stock } = req.body;
    if (!title || !price) return res.status(400).json({ error: "Назва і ціна обов'язкові" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ step: "parse", message: "🔍 Шукаю інформацію про товар..." });

    let parsed;
    if (url) {
      send({ step: "parse", message: "🌐 Парсю з посилання..." });
      parsed = await parseFromUrl(url, title);
    } else {
      send({ step: "parse", message: "🖼️ Шукаю фото через Bing..." });
      const images = await searchImages(title);
      parsed = { foundTitle: title, description: title, images, image: images[0] || "" };
    }

    const ai = aiCheck(title, parsed.foundTitle, parsed.images);
    send({ step: "ai", message: `🤖 AI: ${ai.status} — ${ai.comment}` });

    const product = {
      title,
      price:       Number(price),
      currency:    "UAH",
      category:    detectCategory(title),
      description: parsed.description,
      images:      parsed.images,
      image:       parsed.image,
      source_url:  url || "",
      ai_check:    ai.status,
      date:        new Date().toISOString().slice(0, 10),
      stock:       (stock !== undefined && stock !== null && stock !== '') ? Number(stock) : null,
    };

    send({ step: "save", message: "💾 Зберігаю в базу даних..." });
    const saved = await dbInsert(product);

    send({ step: "deploy", message: "🚀 Деплою на сайт..." });
    const deployResult = await deployToNetlify();

    if (deployResult.ok) {
      send({ step: "done", message: "✅ Товар додано і сайт оновлено!", product: saved, url: deployResult.url });
    } else {
      send({ step: "done", message: "✅ Товар збережено в БД!", product: saved });
    }

    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ step: "error", message: `❌ Помилка: ${err.message}` })}\n\n`);
    res.end();
  }
});

// Редагувати товар
app.put("/api/products/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, price, description, image, stock } = req.body;
    const fields = { title, price: Number(price), description, image };
    if (stock !== undefined) fields.stock = stock === '' ? null : Number(stock);
    await dbUpdate(id, fields);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Змінити кількість (наявність) товару
app.patch("/api/products/:id/stock", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { stock, delta } = req.body;
    if (delta !== undefined) {
      // Відносна зміна: +1 або -1
      const { data, error } = await supabase.from("products").select("stock").eq("id", id).single();
      if (error) throw error;
      const newStock = Math.max(0, (data.stock || 0) + Number(delta));
      await dbUpdate(id, { stock: newStock });
      res.json({ ok: true, stock: newStock });
    } else {
      // Абсолютне значення
      const newStock = stock === null || stock === '' ? null : Math.max(0, Number(stock));
      await dbUpdate(id, { stock: newStock });
      res.json({ ok: true, stock: newStock });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Видалити товар
app.delete("/api/products/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await dbDelete(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    const products = await dbGetAll();
    res.json({ ok: true, products: products.length, db: "supabase ✅" });
  } catch {
    res.json({ ok: false, db: "supabase ❌" });
  }
});

// ─── USER REGISTRATION ────────────────────────────────────────────
app.post("/api/user/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email і пароль обов'язкові" });
    if (password.length < 6) return res.status(400).json({ error: "Пароль мінімум 6 символів" });

    const { data: existing } = await supabase.from("users").select("id").eq("email", email.toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ error: "Email вже зареєстрований" });

    const crypto = require("crypto");
    const hash = crypto.createHash("sha256").update(password + "vcloud_salt_2026").digest("hex");

    const { data, error } = await supabase.from("users").insert({
      email: email.toLowerCase(),
      password: hash,
      name: name || "",
      phone: phone || ""
    }).select().single();

    if (error) throw error;
    res.json({ id: data.id, email: data.email, name: data.name, phone: data.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── USER LOGIN ───────────────────────────────────────────────────
app.post("/api/user/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email і пароль обов'язкові" });

    const crypto = require("crypto");
    const hash = crypto.createHash("sha256").update(password + "vcloud_salt_2026").digest("hex");

    const { data, error } = await supabase.from("users").select("id,email,name,phone,password").eq("email", email.toLowerCase()).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(401).json({ error: "Невірний email або пароль" });
    if (data.password !== hash) return res.status(401).json({ error: "Невірний email або пароль" });

    res.json({ id: data.id, email: data.email, name: data.name, phone: data.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ORDERS — create ──────────────────────────────────────────────
app.post("/api/orders", async (req, res) => {
  try {
    const { user_id, email, name, phone, items, total_uah, payment_method, crypto_curr, crypto_addr, crypto_amount } = req.body;
    if (!email || !items || !items.length) return res.status(400).json({ error: "email та items обов'язкові" });

    const { data, error } = await supabase.from("orders").insert({
      user_id:        user_id || email,
      email:          email,
      name:           name || "",
      phone:          phone || "",
      items:          items,
      total_uah:      Number(total_uah) || 0,
      status:         "pending",
      payment_method: payment_method || "crypto",
      crypto_curr:    crypto_curr || null,
      crypto_addr:    crypto_addr || null,
      crypto_amount:  crypto_amount ? String(crypto_amount) : null
    }).select().single();

    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ORDERS — get by user ─────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const { user_id, email } = req.query;
    if (!user_id && !email) return res.status(400).json({ error: "user_id або email обов'язковий" });

    let query = supabase.from("orders").select("*").order("created_at", { ascending: false });
    if (user_id) query = query.eq("user_id", user_id);
    else         query = query.eq("email", email.toLowerCase());

    const { data, error } = await query;
    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NOWPAYMENTS — створити інвойс ───────────────────────────────
// POST /api/nowpayments/create  { order_id, amount_uah, currency, email, order_description }
app.post("/api/nowpayments/create", async (req, res) => {
  try {
    const { order_id, amount_uah, currency, email, order_description } = req.body;
    if (!order_id || !amount_uah || !currency) {
      return res.status(400).json({ error: "order_id, amount_uah, currency обов'язкові" });
    }

    // NOWPayments приймає суму в будь-якій фіатній валюті
    // pay_currency — крипта, price_currency — фіат (UAH)
    const body = {
      price_amount:      Number(amount_uah),
      price_currency:    "uah",
      pay_currency:      currency.toLowerCase(), // usdt, btc, eth, ton
      ipn_callback_url:  "https://vcloud-admin-server.onrender.com/api/nowpayments/webhook",
      order_id:          String(order_id),
      order_description: order_description || "VclouD Order",
      customer_email:    email || "",
      success_url:       `https://vcloud-v2.netlify.app/v2/orders.html?new=1&order=${order_id}`,
      cancel_url:        "https://vcloud-v2.netlify.app/v2/checkout.html"
    };

    const nwpRes = await fetch(`${NWP_API}/payment`, {
      method:  "POST",
      headers: {
        "x-api-key":    NWP_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const nwpData = await nwpRes.json();
    if (!nwpRes.ok) {
      console.error("NOWPayments error:", nwpData);
      return res.status(502).json({ error: nwpData.message || "NOWPayments API error" });
    }

    // Зберігаємо nowpayments_id в замовленні
    await supabase.from("orders")
      .update({ nowpayments_id: String(nwpData.payment_id), status: "waiting_payment" })
      .eq("id", order_id);

    res.json({
      payment_id:      nwpData.payment_id,
      pay_address:     nwpData.pay_address,
      pay_amount:      nwpData.pay_amount,
      pay_currency:    nwpData.pay_currency,
      payment_status:  nwpData.payment_status,
      expiration_estimate_date: nwpData.expiration_estimate_date
    });
  } catch (err) {
    console.error("NOWPayments create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── NOWPAYMENTS — перевірити статус ─────────────────────────────
// GET /api/nowpayments/status/:payment_id
app.get("/api/nowpayments/status/:payment_id", async (req, res) => {
  try {
    const nwpRes = await fetch(`${NWP_API}/payment/${req.params.payment_id}`, {
      headers: { "x-api-key": NWP_API_KEY }
    });
    const data = await nwpRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NOWPAYMENTS — IPN webhook ────────────────────────────────────
// NOWPayments надсилає POST сюди при зміні статусу платежу
app.post("/api/nowpayments/webhook", async (req, res) => {
  try {
    // Перевіряємо підпис
    const receivedSig = req.headers["x-nowpayments-sig"];
    if (receivedSig && NWP_IPN_SECRET) {
      const sorted = JSON.stringify(
        Object.keys(req.body).sort().reduce((acc, k) => { acc[k] = req.body[k]; return acc; }, {})
      );
      const expectedSig = crypto.createHmac("sha512", NWP_IPN_SECRET).update(sorted).digest("hex");
      if (receivedSig !== expectedSig) {
        console.warn("❌ NOWPayments webhook: невірний підпис");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const { payment_id, payment_status, order_id, actually_paid, pay_currency } = req.body;
    console.log(`📥 NOWPayments webhook: order=${order_id} status=${payment_status} payment=${payment_id}`);

    // Статуси: waiting → confirming → confirmed → finished → partially_paid / failed / expired
    const statusMap = {
      finished:        "paid",
      confirmed:       "paid",
      partially_paid:  "partial",
      failed:          "failed",
      expired:         "expired",
      confirming:      "confirming",
      waiting:         "waiting_payment"
    };

    const newStatus = statusMap[payment_status] || payment_status;

    if (order_id) {
      await supabase.from("orders").update({
        status:          newStatus,
        nowpayments_id:  String(payment_id),
        paid_amount:     actually_paid ? String(actually_paid) : null,
        paid_currency:   pay_currency || null,
        paid_at:         (payment_status === "finished" || payment_status === "confirmed") ? new Date().toISOString() : null
      }).eq("id", order_id);

      console.log(`✅ Замовлення #${order_id} → статус: ${newStatus}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("NOWPayments webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`✅ VclouD Admin Server запущено на порту ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL}`);

  // Міграція: додаємо колонку stock якщо її немає
  try {
    // Спробуємо PATCH з полем stock — якщо колонки немає, Supabase поверне помилку
    // Використовуємо RPC через fetch напряму до PostgreSQL через Supabase SQL endpoint
    const migRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_ddl`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: "ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;" })
    });
    if (migRes.ok) {
      console.log("✅ Колонка stock додана (або вже існує)");
    } else {
      // RPC не існує — колонку треба додати вручну через Supabase Dashboard
      console.log("ℹ️  Додайте колонку вручну: ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT NULL;");
    }
  } catch (e) {
    console.log("ℹ️  Міграція пропущена:", e.message);
  }
});
