-- `return_pending` landlord float stops being a black hole.
--
-- Agents reported two things: a tenant whose landlord float was taken back
-- still appears on the owing list as `repaying` instead of cancelled, and the
-- Landlord Float card still counts float that has already gone back.
--
-- Both trace to the same allocation state: `return_pending`.
--
-- 1. THE RECALL COULD NOT SEE IT
--
-- `detect_idle_landlord_float` selected allocations
-- `WHERE al.status IN ('open','partially_paid')`. Once an allocation moved to
-- `return_pending` it dropped out of the detector's view entirely, so the
-- 24-hour recall never ran on it: the plan was never cancelled, the tenant was
-- never told, and the agent kept being asked to collect from them.
--
-- `cancel_tenant_and_return_landlord_float` has ALWAYS handled
-- `return_pending` — its FOR UPDATE loop lists it explicitly. Only the detector
-- that decides what to hand it was blind to the state.
--
-- MEASURED 2026-10-05 — three plans, UGX 750,000, all with the landlord unpaid
-- (`paid_out_amount = 0`) and the plan still `funded` and collectable:
--
--   Ndibaisa Deborah   250,000   stuck 428 hours  (17.8 days)
--   Doreen Walulya     300,000   stuck  94.7 hours
--   Tezicha Tomath     200,000   stuck  67.4 hours
--
-- Doreen Walulya is the case the agent screenshotted: her plan reads
-- UGX 419,000 to collect while her landlord has had nothing and the float sits
-- waiting to go back.
--
-- NOT A BUG, FOR THE RECORD: the other 14 recalled plans that agents saw as
-- `pending` / `agent_ops_approved` / `repaying` rather than cancelled are the
-- resubmission flow working. Every one has `resubmission_count >= 1`, and the
-- five now `repaying` carry a SECOND allocation marked `fully_paid` — they were
-- cancelled, resubmitted, re-funded, and their landlords were paid on the
-- retry. Those tenants are collectable because they should be.
--
-- 2. THE FLOAT CARD COUNTED MONEY THE AGENT CANNOT SPEND
--
-- `get_agent_lp_float_available` deducted payouts that were verified but not
-- yet settled, and nothing else. Float in `return_pending` is on its way back
-- to the pool and cannot fund anything, but it was still being offered.
--
--   NSUBUGA Lawrence George   balance 550,000   of which 300,000 returning
--   Saka Homi Melvin          balance 250,000   of which 250,000 returning
--   kirunda Ivan              balance 200,000   of which 200,000 returning
--
-- Two of those three agents had a card showing a quarter of a million shillings
-- and nothing whatsoever to spend.

-- 1. The recall sees float that is pending return ---------------------------
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'detect_idle_landlord_float';
  IF v_src IS NULL THEN RAISE EXCEPTION 'detect_idle_landlord_float not found'; END IF;
  IF v_src LIKE '%al.status IN (''open'',''partially_paid'',''return_pending'')%' THEN
    RAISE NOTICE 'Already applied - the detector already sees return_pending.';
    RETURN;
  END IF;

  v_new := replace(v_src,
    'WHERE al.status IN (''open'',''partially_paid'')',
    'WHERE al.status IN (''open'',''partially_paid'',''return_pending'')');
  IF v_new = v_src THEN RAISE EXCEPTION 'detector allocation-status anchor not found'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.detect_idle_landlord_float(p_system_actor uuid DEFAULT NULL::uuid)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;

-- 2. Spendable float excludes float that is going back ----------------------
--
-- This is the figure the disbursement backend enforces, so it must not promise
-- money the payout will then refuse. Rebuilt in full rather than patched: the
-- function is six lines and restating it is clearer than an anchor.
CREATE OR REPLACE FUNCTION public.get_agent_lp_float_available(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(
    0,
    COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent_id), 0)
    -- Ring-fenced by a payout already verified but not yet paid out.
    - COALESCE((
        SELECT SUM(amount)
        FROM public.landlord_payouts
        WHERE agent_id = p_agent_id
          AND status IN ('otp_verified','pending_merchant_payout')
      ), 0)
    -- Float already on its way back to the pool. The agent cannot spend it,
    -- so showing it as available means offering money the payout will refuse.
    - COALESCE((
        SELECT SUM(remaining_amount)
        FROM public.agent_landlord_float_allocations
        WHERE agent_id = p_agent_id
          AND status = 'return_pending'
      ), 0)
  );
$function$;

COMMENT ON FUNCTION public.get_agent_lp_float_available(uuid) IS
  'Landlord float an agent can actually spend: gross balance less payouts '
  'already verified and awaiting settlement, less float in return_pending on '
  'its way back to the pool. The gross agent_landlord_float.balance counts '
  'both and must not be shown to an agent as available.';

-- Verified after applying: all three stuck allocations now qualify for the
-- detector, none has a dispatched payout, so the next run recalls them,
-- cancels the plans and sends A4 + T2. Spendable float for the three affected
-- agents drops to 0, 0 and 0 from 550,000, 250,000 and 200,000.
