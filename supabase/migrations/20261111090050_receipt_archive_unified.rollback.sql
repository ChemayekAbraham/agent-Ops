-- Rolls back 20261111090000_receipt_archive_unified.sql. Read-only functions only; no data is lost.
-- The counter lift to 4299 is NOT undone: receipt numbers must never go backwards once issued.
DROP FUNCTION IF EXISTS public.receipt_archive_summary(date, date);
DROP FUNCTION IF EXISTS public.search_receipt_archive(text, text, date, date, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.receipt_phone_key(text);
