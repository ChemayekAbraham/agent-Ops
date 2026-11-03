-- Rollback for docs/pending-migrations/welile_homes_float_link.sql
--
-- What it does, in one transaction:
--   1. Refuses, changing nothing, if any Welile Homes float request has been disbursed through
--      wh_cfo_disburse_float (disbursed_ledger_txn set) or any subscription link row exists.
--      Those rows are the only record tying a ledger posting to the subscriptions it funded;
--      dropping them would orphan real money movements. Resolve them first (keep the migration).
--   2. Removes the three Welile Homes float functions and both guard triggers/functions.
--   3. Drops the link table, funding_status, product, disbursed_ledger_txn, their constraints and index.
--
-- What it does NOT do: it touches no wallet, balance, ledger entry or float request status.
-- Run as one transaction (it has its own BEGIN; ... COMMIT;).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.welile_homes_float_request_items') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.welile_homes_float_request_items) THEN
    RAISE EXCEPTION 'Rollback refused: welile_homes_float_request_items has rows (subscription links would be lost)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'float_requests'
                AND column_name = 'disbursed_ledger_txn') THEN
    IF EXISTS (SELECT 1 FROM public.float_requests WHERE disbursed_ledger_txn IS NOT NULL) THEN
      RAISE EXCEPTION 'Rollback refused: float requests already disbursed through wh_cfo_disburse_float';
    END IF;
  END IF;
END $pre$;

-- 1. Functions
DROP FUNCTION IF EXISTS public.wh_cfo_disburse_float(uuid);
DROP FUNCTION IF EXISTS public.wh_float_advance(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.wh_request_float(uuid[], text, text);

-- 2. Guards
DROP TRIGGER IF EXISTS trg_wh_float_guard ON public.float_requests;
DROP TRIGGER IF EXISTS trg_wh_funding_status_guard ON public.welile_homes_subscriptions;
DROP FUNCTION IF EXISTS public._wh_float_guard();
DROP FUNCTION IF EXISTS public._wh_funding_status_guard();

-- 3. Link table
DROP TABLE IF EXISTS public.welile_homes_float_request_items;

-- 4. Columns
ALTER TABLE public.welile_homes_subscriptions
  DROP CONSTRAINT IF EXISTS wh_subs_funding_status_chk,
  DROP COLUMN IF EXISTS funding_status;

DROP INDEX IF EXISTS public.float_requests_product_status_idx;
ALTER TABLE public.float_requests
  DROP CONSTRAINT IF EXISTS float_requests_product_chk,
  DROP COLUMN IF EXISTS disbursed_ledger_txn,
  DROP COLUMN IF EXISTS product;

COMMIT;
