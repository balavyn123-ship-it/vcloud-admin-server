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
