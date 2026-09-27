-- Agent Advance waterfall, Stage C: effective point and ledger-derived
-- component state.
--
-- NOT YET APPLIED to production as part of this package. Four helper functions
-- and one config row. All inert: nothing calls them until Stage E wires the
-- repayment paths.
--
-- WHY LEDGER-DERIVED AND NOT NEW COLUMNS
-- --------------------------------------
-- The waterfall needs a remaining balance per component. The existing book
-- cannot supply one: historical repayments were credited wholly to A10 and
-- were never component-allocated, and 111 of 327 open advances do not even
-- reconcile `charged - collected` to `outstanding_balance` -- 103 of them for
-- reasons no record explains. That is why Option 1 (seed an opening
-- allocation) was rejected and Option 3 (new advances only) was chosen.
--
-- For advances issued from the effective point, the component state is derived
-- from the general ledger itself: each component is the net DEBIT of its own
-- category pair on its own account. No new mutable columns, nothing to drift,
-- and the allocation state IS the ledger rather than a second opinion about it.
--
--   Late Fee          agent_advance_penalty_accrued[_external]        -> A10
--   Access Fee        agent_advance_access_fee_*                      -> A11
--   Registration Fee  agent_advance_registration_fee_*                -> A20
--   Principal         agent_advance_disbursement / _repayment /
--                     _repayment_external / _written_off / _reversed  -> A10
--   Unearned Late Fee agent_advance_penalty_unearned                  -> L8
--
-- The sign is taken from `ledger_account_map.debit_when` rather than
-- hard-coded, so the same reader is correct on the wallet route (receivable
-- credits posted cash_in) and the external route (posted cash_out).
--
-- TWO INVARIANTS, both verified rolled-back against live data
--   1. late + access + registration + principal == outstanding_balance
--   2. L8 balance == remaining capitalised Late Fee
-- Invariant 2 is what stops Late Fee income being released from an L8 that
-- does not hold it. Under Option 1 it would have driven L8 negative by up to
-- 2,521,517.
--
-- EFFECTIVE POINT
-- ---------------
-- Stored once in `treasury_controls` as the single source of truth. The regime
-- of an advance is `issued_at >= effective point`; no per-advance column.
-- `agent_advance_allocation_entries` returns NULL for pre-effective advances,
-- which is how the existing 327 keep their current treatment -- by
-- construction, not by convention.
--
-- The INSERT below uses a fixed timestamp so the migration is deterministic and
-- replayable. Set it to the intended deployment moment before applying.

INSERT INTO public.treasury_controls (control_key, enabled, value, updated_at)
VALUES ('agent_advance_waterfall_from', true, '2026-09-27 14:37:17.448571+00', now())
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.agent_advance_waterfall_from()
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN COALESCE(enabled, false) THEN value::timestamptz END
  FROM public.treasury_controls
  WHERE control_key = 'agent_advance_waterfall_from'
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.agent_advance_is_post_effective(p_advance_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    a.issued_at >= public.agent_advance_waterfall_from(),
    false
  )
  FROM public.agent_advances a
  WHERE a.id = p_advance_id;
$function$;

CREATE OR REPLACE FUNCTION public.agent_advance_component_state(p_advance_id uuid)
 RETURNS TABLE(late_fee numeric, access_fee numeric, registration_fee numeric,
               principal numeric, unearned_late_fee numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH legs AS (
    SELECT g.category,
           CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END AS net_dr
    FROM public.general_ledger g
    JOIN public.ledger_account_map m
      ON m.category = g.category AND m.ledger_scope = g.ledger_scope AND m.wallet_bucket IS NULL
    WHERE g.source_table = 'agent_advances' AND g.source_id = p_advance_id
  )
  SELECT
    COALESCE(SUM(net_dr) FILTER (WHERE category IN
      ('agent_advance_penalty_accrued','agent_advance_penalty_accrued_external')), 0),
    COALESCE(SUM(net_dr) FILTER (WHERE category LIKE 'agent_advance_access_fee%'), 0),
    COALESCE(SUM(net_dr) FILTER (WHERE category LIKE 'agent_advance_registration_fee%'), 0),
    COALESCE(SUM(net_dr) FILTER (WHERE category IN
      ('agent_advance_disbursement','agent_advance_repayment',
       'agent_advance_repayment_external','agent_advance_written_off','agent_advance_reversed')), 0),
    COALESCE(-SUM(net_dr) FILTER (WHERE category = 'agent_advance_penalty_unearned'), 0)
  FROM legs;
$function$;

-- Returns the PLATFORM allocation legs for a repayment, or NULL when the
-- advance predates the effective point. Callers keep their own funding leg
-- untouched and simply append this, so no funding route changes and the wallet
-- movement remains exactly the repayment amount.
CREATE OR REPLACE FUNCTION public.agent_advance_allocation_entries(
  p_advance_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_transaction_date timestamptz DEFAULT now(),
  p_external boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  st        record;
  v_total   numeric;
  v_late    numeric; v_fee numeric; v_reg numeric; v_prin numeric;
  v_dir_cr  text;    -- direction that CREDITS a receivable on this funding route
  v_out     jsonb := '[]'::jsonb;
  c_late    text; c_fee text; c_reg text; c_prin text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN NULL; END IF;
  IF NOT public.agent_advance_is_post_effective(p_advance_id) THEN RETURN NULL; END IF;

  SELECT * INTO st FROM public.agent_advance_component_state(p_advance_id);

  v_total := GREATEST(st.late_fee,0) + GREATEST(st.access_fee,0)
           + GREATEST(st.registration_fee,0) + GREATEST(st.principal,0);
  IF p_amount > v_total + 1 THEN
    RAISE EXCEPTION
      'ADVANCE_ALLOCATION_OVER_COLLECTION: advance % payment % exceeds remaining components % (late %, access %, reg %, principal %)',
      p_advance_id, p_amount, v_total, st.late_fee, st.access_fee, st.registration_fee, st.principal;
  END IF;

  -- Waterfall: Late Fee -> Access Fee -> Registration Fee -> Principal
  v_late := LEAST(p_amount, GREATEST(st.late_fee,0));
  v_fee  := LEAST(GREATEST(p_amount - v_late, 0), GREATEST(st.access_fee,0));
  v_reg  := LEAST(GREATEST(p_amount - v_late - v_fee, 0), GREATEST(st.registration_fee,0));
  v_prin := GREATEST(p_amount - v_late - v_fee - v_reg, 0);

  -- Receivable credits mirror the funding leg so raw cash_in = cash_out:
  --   wallet route   funding cash_out -> credits cash_in
  --   external route funding cash_in  -> credits cash_out
  IF p_external THEN
    v_dir_cr := 'cash_out';
    c_late := 'agent_advance_penalty_accrued_external';
    c_fee  := 'agent_advance_access_fee_collected_external';
    c_reg  := 'agent_advance_registration_fee_collected_external';
    c_prin := 'agent_advance_repayment_external';
  ELSE
    v_dir_cr := 'cash_in';
    c_late := 'agent_advance_penalty_accrued';
    c_fee  := 'agent_advance_access_fee_collected';
    c_reg  := 'agent_advance_registration_fee_collected';
    c_prin := 'agent_advance_repayment';
  END IF;

  IF v_late > 0 THEN
    -- The L8 debit is cash_out and the R3 credit is cash_in on BOTH routes:
    -- they belong to the release pair and do not mirror the funding leg.
    v_out := v_out
      || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction',v_dir_cr,
           'amount',v_late,'category',c_late,'recipient_type','operational_wallet',
           'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
           'transaction_date',p_transaction_date,'description','Late Fee settled from repayment')
      || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction','cash_out',
           'amount',v_late,'category','agent_advance_penalty_unearned','recipient_type','operational_wallet',
           'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
           'transaction_date',p_transaction_date,'description','Unearned Late Fee released on collection')
      || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction','cash_in',
           'amount',v_late,'category','agent_advance_late_fee_income','recipient_type','operational_wallet',
           'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
           'transaction_date',p_transaction_date,'description','Late Fee income recognised on collection');
  END IF;

  IF v_fee > 0 THEN
    v_out := v_out || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction',v_dir_cr,
      'amount',v_fee,'category',c_fee,'recipient_type','operational_wallet',
      'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
      'transaction_date',p_transaction_date,'description','Access fee share of repayment');
  END IF;

  IF v_reg > 0 THEN
    v_out := v_out || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction',v_dir_cr,
      'amount',v_reg,'category',c_reg,'recipient_type','operational_wallet',
      'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
      'transaction_date',p_transaction_date,'description','Registration fee share of repayment');
  END IF;

  IF v_prin > 0 THEN
    v_out := v_out || jsonb_build_object('user_id',p_agent_id,'ledger_scope','platform','direction',v_dir_cr,
      'amount',v_prin,'category',c_prin,'recipient_type','operational_wallet',
      'source_table','agent_advances','source_id',p_advance_id,'currency','UGX',
      'transaction_date',p_transaction_date,'description','Principal share of repayment');
  END IF;

  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.agent_advance_component_state(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.agent_advance_is_post_effective(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.agent_advance_allocation_entries(uuid, uuid, numeric, timestamptz, boolean) FROM PUBLIC, anon;
