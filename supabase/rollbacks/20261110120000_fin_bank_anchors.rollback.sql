-- Rollback for 20261110120000_fin_bank_anchors.sql (reporting only).
DROP FUNCTION IF EXISTS public.fin_bank_anchor(text);
DROP TABLE IF EXISTS public.fin_bank_anchors;
