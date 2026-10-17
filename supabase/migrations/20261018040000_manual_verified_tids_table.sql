-- Finance-verified TIDs that may back agent float without a gmail_transactions row.
--
-- Why: tg_credit_tid_backed_float() marks a deposit_requests float credit as
-- TID-backed only when a gmail_transactions row with the same TID exists. When a
-- MoMo or Airtel message is lost before ingestion, Financial Ops verifies the TID
-- on the telco statement and approves the deposit by hand. The float arrived but
-- was never TID-backed, so rent collection was capped. Each case needed a
-- one-off backfill (20261018000000 and following).
--
-- This table is the finance side of the fix. A row says: Financial Ops checked
-- this exact TID on the telco statement for this user and this amount. The next
-- file teaches the trigger to honour it exactly once.
--
-- Service role and SECURITY DEFINER functions only. No policies, and all grants to
-- anon and authenticated are revoked, so the app and PostgREST cannot read or
-- write it.

CREATE TABLE IF NOT EXISTS public.manual_verified_tids (
  tid_normalized text PRIMARY KEY,
  user_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  note text,
  registered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

ALTER TABLE public.manual_verified_tids ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.manual_verified_tids FROM anon, authenticated;
