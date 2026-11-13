-- Partner receipts: remove the default table grants Supabase added when the tables were created.
--
-- 20261105180000_partner_receipts.sql granted authenticated SELECT and service_role ALL, but the project's default privileges had
-- already given `authenticated` every table privilege and `anon` SELECT. Row-level security (no write policies, plus the
-- partner_receipts_protect triggers) still blocked all of it, so nothing was exposed; this removes the second hole.
--
-- AFTER: anon has nothing. authenticated can only SELECT the three receipt tables (RLS limits that to Financial Ops, CFO, super
-- admin and Partner Ops) and has no access to the counter. Every write goes through the SECURITY DEFINER RPCs, which run as the
-- table owner. service_role keeps ALL.
-- Roll back by re-granting what you want; nothing here deletes data.

REVOKE ALL ON public.partner_receipts, public.partner_receipt_corrections, public.partner_receipt_events, public.partner_receipt_counter FROM anon;
REVOKE ALL ON public.partner_receipt_counter FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.partner_receipts, public.partner_receipt_corrections, public.partner_receipt_events FROM authenticated;
GRANT SELECT ON public.partner_receipts, public.partner_receipt_corrections, public.partner_receipt_events TO authenticated;
