const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const path = require("path");
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL та SUPABASE_KEY обов'язкові (env variables)");
  process.exit(1);
}
if (!NETLIFY_TOKEN || !NETLIFY_SITE_ID) {
  console.warn("⚠️  NETLIFY_TOKEN або NETLIFY_SITE_ID не задані — деплой не працюватиме");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
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
async function deployToNetlify() {
  // Беремо всі товари з Supabase
  const allProducts = await dbGetAll();

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const jsContent = `// VclouD Products\n// Updated: ${now}\n// Total: ${allProducts.length}\n\nconst products = ${JSON.stringify(allProducts, null, 2)};\n`;

  const crypto = require("crypto");
  const fileHash = crypto.createHash("sha1").update(jsContent).digest("hex");

  // Крок 1: створюємо деплой з хешем файлу
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: { "/js/products.js": fileHash } }),
  });
  const deployData = await deployRes.json();
  const deployId = deployData.id;

  if (!deployId) return { ok: false, error: deployData };

  // Крок 2: завантажуємо файл
  await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/files/js/products.js`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      "Content-Type": "application/javascript",
    },
    body: jsContent,
  });

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

// Отримати всі товари
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
    const { title, price, url } = req.body;
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
    const { title, price, description, image } = req.body;
    await dbUpdate(id, { title, price: Number(price), description, image });
    await deployToNetlify();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Видалити товар
app.delete("/api/products/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await dbDelete(id);
    await deployToNetlify();
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

app.listen(PORT, () => {
  console.log(`✅ VclouD Admin Server запущено на порту ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL}`);
});
