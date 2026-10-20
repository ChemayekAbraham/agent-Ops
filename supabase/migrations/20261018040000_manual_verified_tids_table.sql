-- Finance-verified TIDs that may back agent float without a gmail_transactions row.
--
-- tg_credit_tid_backed_float() marks a deposit_requests float credit as TID-backed
-- only when a gmail_transactions row with the same TID exists. When a MoMo or
-- Airtel message is lost before ingestion, Financial Ops verifies the TID on the
-- telco statement and approves the deposit by hand. The float arrived but was never
-- TID-backed, so rent collection was capped.
--
-- This table is the finance side of the fix. A row says Financial Ops checked this
-- exact TID on the telco statement for this user and this amount. The trigger
-- update in 20261018040100 honours it exactly once.
--
-- Run this file ALONE as a single statement. Row level security is enabled in
-- 20261018040001 and access is revoked in 20261018040002.

CREATE TABLE IF NOT EXISTS public.manual_verified_tids (
  tid_normalized text PRIMARY KEY,
  user_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  note text,
  registered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
