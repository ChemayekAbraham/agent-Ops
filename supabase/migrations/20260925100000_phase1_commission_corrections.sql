-- Phase 1 — commission corrections
--
-- Spec: docs/rent-plan-new-flow-full-report.md §8 "Phase 1", items 1–4.
-- Background: docs/commission-policy-decisions-2026-09-23.md
--
-- The decisions being implemented:
--   * posting a rent request earns nothing;
--   * a landlord bonus is paid ONCE PER LANDLORD, never per rent request;
--   * the funding bonus is 5,000 from one code path, not 5,000 + 10,000;
--   * the parent agent earns nothing on landlord verification, LC1
--     verification, or a tenant's landlord being funded.
--
-- Historical payments are NOT clawed back. Everything here is forward-only.
--
-- Ledger impact: none. No ledger_account_map row changes, no new categories,
-- so ledger_category_allowlist() and balancedLedgerPost.ts are untouched.
-- The surviving bonus paths keep their existing shape (wallet agent_commission
-- -> L1 fallback, platform marketing_expense -> X1).

-- ---------------------------------------------------------------------------
-- 1. Posting a rent request earns nothing
--
-- trg_pay_listed_rent_posted_bonus fired on every rent request carrying a
-- house_listing_id and called credit_agent_event_bonus with the key
-- 'rent_posted_listed', which that function has never recognised — so it
-- returned an error object that PERFORM discarded and paid nothing. Zero
-- 'rent_request_posted' rows have ever existed in commission_accrual_ledger.
--
-- It is dropped rather than repaired: the rent-request entry points have no
-- option to link an empty house, so the trigger is unreachable in normal use,
-- and leaving a disabled 5,000 in place invites a future "fix" that would
-- silently switch on a payout nobody decided to make.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pay_listed_rent_posted_bonus ON public.rent_requests;
DROP FUNCTION IF EXISTS public.pay_listed_rent_posted_bonus();

-- ---------------------------------------------------------------------------
-- 2. One landlord bonus per landlord, never one per rent request
--
-- trg_pay_listed_landlord_verified_bonus fired when landlords.verified went
-- false -> true and then LOOPED over every rent request naming that landlord,
-- calling credit_agent_event_bonus once per loop. A landlord with five rent
-- requests would have paid five bonuses. It never actually paid, because
-- 'rent_landlord_verified' is not a key the function recognises.
--
-- The correct path survives untouched: pay_landlord_registration_verified_bonus
-- fires on the same transition, is guarded by
-- landlords.registration_verification_bonus_paid, and carries the idempotency
-- key 'landlord_reg_verify_v2:<id>'. One new landlord, one bonus, ever.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pay_listed_landlord_verified_bonus ON public.landlords;
DROP FUNCTION IF EXISTS public.pay_listed_landlord_verified_bonus();

-- ---------------------------------------------------------------------------
-- 3. The funding bonus is paid once, by one code path
--
-- Two independent paths paid on the same event:
--   * fund-agent-landlord-float posted a flat 5,000 inline;
--   * trg_credit_agent_rent_funded_bonus posted 10,000 through
--     credit_agent_event_bonus('rent_funded_landlord_float').
-- Different amounts, different ledger categories, different idempotency
-- namespaces — so neither could see the other and the agent received both.
--
-- This drops the 10,000. The flat 5,000 is removed separately in the edge
-- function, leaving the 1% landlord-payout commission as the only payment at
-- that stage.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_credit_agent_rent_funded_bonus ON public.rent_requests;
DROP FUNCTION IF EXISTS public.credit_agent_rent_funded_bonus();

-- ---------------------------------------------------------------------------
-- 4. The parent agent earns nothing on verification or funding
--
-- Three triggers paid a recruiter override through credit_recruiter_override.
-- The amount was never chosen for these events: the function's CASE names only
-- 'house_listed_verified' (2,000) and everything else falls to an ELSE of
-- 3,000. Verification money is now solely the registering agent's.
--
-- trg_recruiter_override_house_verified on house_listings is deliberately
-- retained — the house-listing override is unchanged.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_recruiter_override_landlord_verified ON public.landlords;
DROP FUNCTION IF EXISTS public.pay_recruiter_override_landlord_verified();

DROP TRIGGER IF EXISTS trg_recruiter_override_lc1_verified ON public.lc1_chairpersons;
DROP FUNCTION IF EXISTS public.pay_recruiter_override_lc1_verified();

DROP TRIGGER IF EXISTS trg_recruiter_override_tenant_landlord_funded ON public.rent_requests;
DROP FUNCTION IF EXISTS public.pay_recruiter_override_tenant_landlord_funded();

-- ---------------------------------------------------------------------------
-- 5. The event-bonus price list
--
-- Removed: 'rent_request_posted' (contradicts item 1), 'tenant_replacement'
-- (never wired, never paid) and 'rent_funded_landlord_float' (item 3).
--
-- Retained, with their callers:
--   house_listed          2,000   supabase/functions/credit-listing-bonus
--   subagent_registration 10,000  try_award_subagent_registration_bonus()
--   three_verified_houses 10,000  advance_campaign_house_progress()
--   tenant_placement      10,000  pay_tenant_placement_bonus() on house_listings
--   service_centre_setup  25,000  src/components/cfo/ServiceCentrePayoutApproval
--
-- Everything else about the function is unchanged: the same duplicate check on
-- commission_accrual_ledger, the same idempotency key, and the same ledger
-- shape (wallet agent_commission / platform marketing_expense).
--
-- NOTE, not fixed here: agent_capture_contact_location() calls this function
-- with 'contact_location_capture', which has never been a recognised key, so
-- the UGX 100 location bonus has never paid. That is a separate decision.
-- ---------------------------------------------------------------------------
-- The last two parameters keep their existing defaults; CREATE OR REPLACE
-- cannot remove parameter defaults from an existing function.
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid DEFAULT NULL::uuid,
  p_source_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_row_id UUID;
  v_now TIMESTAMPTZ := now();
  v_group_id UUID;
  v_idem TEXT;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_agent');
  END IF;

  v_amount := CASE p_event_type
    WHEN 'house_listed'               THEN 2000
    WHEN 'subagent_registration'      THEN 10000
    WHEN 'three_verified_houses'      THEN 10000
    WHEN 'tenant_placement'           THEN 10000
    WHEN 'service_centre_setup'       THEN 25000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'house_listed'               THEN 'Bonus: Empty house listed'
    WHEN 'subagent_registration'      THEN 'Bonus: Sub-agent registration'
    WHEN 'three_verified_houses'      THEN 'Bonus: Sub-agent listed 3 verified houses'
    WHEN 'tenant_placement'           THEN 'Bonus: Tenant placement'
    WHEN 'service_centre_setup'       THEN 'Bonus: Service Centre setup'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  INSERT INTO commission_accrual_ledger (
    agent_id, event_type, commission_role, source_type, tenant_id, source_id,
    amount, description, status, earned_at, created_at
  ) VALUES (
    p_agent_id, p_event_type, 'event_bonus', p_event_type, p_tenant_id, p_source_id,
    v_amount, v_description, 'pending', v_now, v_now
  )
  RETURNING id INTO v_row_id;

  -- Pay through the ledger. apply_wallet_movement no longer writes buckets
  -- (the ledger is the sole source of truth) and its old parameter list is
  -- gone — calling it here is what aborted landlord-float funding transactions.
  v_idem := 'agent_event_bonus:' || p_event_type || ':' || COALESCE(p_source_id, v_row_id::text);

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', v_description
        ),
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', 'Marketing expense: ' || v_description
        )
      ),
      v_idem
    );
  EXCEPTION WHEN unique_violation THEN
    UPDATE commission_accrual_ledger
    SET status = 'credited', paid_at = v_now
    WHERE id = v_row_id;
    RETURN jsonb_build_object('status', 'already_credited', 'event_type', p_event_type);
  END;

  UPDATE commission_accrual_ledger
  SET status = 'credited', paid_at = v_now
  WHERE id = v_row_id;

  RETURN jsonb_build_object(
    'status', 'credited',
    'event_type', p_event_type,
    'amount', v_amount,
    'description', v_description,
    'transaction_group_id', v_group_id
  );
END;
$function$;
