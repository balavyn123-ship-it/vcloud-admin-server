-- ============================================
-- Запусти цей SQL в Supabase SQL Editor
-- supabase.com → твій проект → SQL Editor
-- ============================================

-- Таблиця товарів
CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT        NOT NULL,
  price       INTEGER     NOT NULL,
  currency    TEXT        DEFAULT 'UAH',
  category    TEXT        DEFAULT 'other',
  description TEXT        DEFAULT '',
  images      JSONB       DEFAULT '[]',
  image       TEXT        DEFAULT '',
  source_url  TEXT        DEFAULT '',
  ai_check    TEXT        DEFAULT '',
  date        DATE        DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Дозволяємо читання всім (для фронтенду)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON products
  FOR SELECT USING (true);

CREATE POLICY "Service role full access" ON products
  FOR ALL USING (auth.role() = 'service_role');

-- Індекс для швидкого пошуку
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_date ON products(date DESC);

-- Перевірка
SELECT 'Таблиця products створена ✅' as result;

-- ============================================
-- Таблиця замовлень
-- ============================================
CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  user_id        TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  name           TEXT        DEFAULT '',
  phone          TEXT        DEFAULT '',
  items          JSONB       NOT NULL DEFAULT '[]',
  total_uah      INTEGER     NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'pending',
  payment_method TEXT        DEFAULT 'crypto',
  crypto_curr    TEXT        DEFAULT NULL,
  crypto_addr    TEXT        DEFAULT NULL,
  crypto_amount  TEXT        DEFAULT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_orders" ON orders FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email   ON orders(email);

-- ============================================
-- Таблиця користувачів
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  name       TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_users" ON users FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

SELECT 'Таблиці orders та users створені ✅' as result;
