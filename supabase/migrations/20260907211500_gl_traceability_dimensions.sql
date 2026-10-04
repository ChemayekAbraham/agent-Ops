-- PHASE 1 (4/5): prospective traceability dimensions on general_ledger.
-- Nullable, no default => metadata-only, no rewrite of the 455,912 existing rows.
-- Historical rows stay NULL BY DESIGN. Do not backfill by inference.
ALTER TABLE public.general_ledger ADD COLUMN IF NOT EXISTS instalment_id   uuid;
ALTER TABLE public.general_ledger ADD COLUMN IF NOT EXISTS rent_request_id uuid;
CREATE INDEX IF NOT EXISTS idx_gl_instalment_id   ON public.general_ledger(instalment_id)   WHERE instalment_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_rent_request_id ON public.general_ledger(rent_request_id) WHERE rent_request_id IS NOT NULL;
