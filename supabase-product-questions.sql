-- ─────────────────────────────────────────────────────────────────────────────
-- Product Q&A: customer questions + admin answers on product pages
-- ─────────────────────────────────────────────────────────────────────────────
-- Storefront (anon) inserts questions as status 'pending'; only 'published' rows
-- are publicly readable. Admin moderation goes through /api/product-questions
-- (service-role key, bypasses RLS) to answer / publish / hide / delete.
--
-- Already applied to the live DB via the connector; kept here for reproducibility.
CREATE TABLE IF NOT EXISTS public.product_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text,
  asker_name text,
  status text NOT NULL DEFAULT 'pending',   -- pending | published | hidden
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

ALTER TABLE public.product_questions ENABLE ROW LEVEL SECURITY;

-- Anyone may ASK (insert) — forced to a pending, unanswered row with a sane length.
DROP POLICY IF EXISTS "ask a question" ON public.product_questions;
CREATE POLICY "ask a question" ON public.product_questions
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'pending' AND answer IS NULL AND char_length(question) BETWEEN 3 AND 1000);

-- Anyone may READ published Q&A.
DROP POLICY IF EXISTS "read published questions" ON public.product_questions;
CREATE POLICY "read published questions" ON public.product_questions
  FOR SELECT TO anon, authenticated
  USING (status = 'published');

CREATE INDEX IF NOT EXISTS idx_product_questions_product ON public.product_questions(product_id, status);
