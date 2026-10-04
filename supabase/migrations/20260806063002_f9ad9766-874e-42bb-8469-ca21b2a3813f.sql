-- 1) Explicit flag for pool/bulk-funded settlements (one physical bank transfer
--    legitimately covering many proxy payouts). Previously this was only a
--    request-body parameter in approve-withdrawal, invisible at the DB layer.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS pool_funded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.withdrawal_requests.pool_funded IS
  'True when this payout was settled as part of a bulk/pool company bank transfer (SKYBUBBLES bulk-bank match). Such rows legitimately share one fin_ops_reference and are exempt from the settlement-reference uniqueness rule.';

-- Backfill from the authoritative bulk allocation ledger.
UPDATE public.withdrawal_requests w
SET pool_funded = true
WHERE pool_funded IS NOT TRUE
  AND EXISTS (
    SELECT 1 FROM public.bulk_bank_payout_allocations b
    WHERE b.withdrawal_request_id = w.id
  );

-- 2) THE ACTUAL FIX — unconditional, non-time-boxed uniqueness on the
--    settlement reference for settled, non-pool-funded payouts.
--    Scoped to rows created from 2026-08-06 onward: historical data contains
--    legacy manual references that were intentionally reused (test codes,
--    pre-guard operator entries) and must not be rewritten. The cutoff literal
--    is immutable, so it is valid in an index predicate.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_fin_ops_reference_uq
  ON public.withdrawal_requests (fin_ops_reference)
  WHERE fin_ops_reference IS NOT NULL
    AND status IN ('completed', 'processing', 'paid', 'disbursed')
    AND pool_funded IS NOT TRUE
    AND created_at >= '2026-08-06 00:00:00+00'::timestamptz;

-- 3) Defense-in-depth only: widen the proxy-partner resubmission window.
--    A time window is leaky by construction; the unique index above is the fix.
CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  duplicate_id uuid;
  window_minutes int := 15;
  -- Proxy partner payouts are manually keyed by an agent who may re-submit
  -- after doubting whether the first attempt landed. 15 minutes was too short.
  proxy_window_minutes int := 60;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending'
     AND NEW.status IS DISTINCT FROM 'manager_approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'mobile_money'
      AND mobile_money_provider IS NOT DISTINCT FROM NEW.mobile_money_provider
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'bank_transfer'
        AND NEW.bank_account_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'bank_transfer'
      AND bank_name IS NOT DISTINCT FROM NEW.bank_name
      AND bank_account_number = NEW.bank_account_number
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'cash' THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NULL
     AND NEW.proxy_partner_id IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND proxy_partner_id = NEW.proxy_partner_id
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => proxy_window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical request submitted recently (id=%)',
      duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;