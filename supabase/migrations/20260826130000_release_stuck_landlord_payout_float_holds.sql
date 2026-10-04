-- ─────────────────────────────────────────────────────────────────────────────
-- Landlord Payout Float: stop stuck payout rows from ring-fencing float forever
--
-- SYMPTOM (agent side): "Available to pay: UGX 0" while "Total float UGX X ·
-- UGX X is already held by landlord payouts awaiting cash-out". The agent is
-- holding real CFO-allocated float but cannot spend any of it.
--
-- ROOT CAUSE: `get_agent_lp_float_available` reserved against EVERY
-- `landlord_payouts` row in ('otp_verified','pending_merchant_payout') with no
-- time bound and no reference to the merchant withdrawal that actually backs
-- it. Those two statuses are only cleared by `approve-withdrawal` (settle) and
-- `reject-withdrawal` (reject). Any other way the backing withdrawal dies —
-- `fraud-cutoff-account` rejecting it, `reverse-auto-routed-withdrawal`
-- reversing it, `cancel-proxy-withdrawal` / `delete-user` cancelling it, a
-- rejection that ran while the payout was still 'otp_verified' and so missed
-- reject-withdrawal's narrow `status = 'pending_merchant_payout'` guard, or the
-- disburse function dying between the payout insert and the withdrawal insert —
-- leaves the payout row parked in a reserving status permanently. The float was
-- NEVER debited for those rows, so the balance stays whole while the
-- reservation eats it, and the hold then applies to every future CFO
-- allocation, not just the cycle it came from.
--
-- FIX: derive the hold from the LIVE backing withdrawal instead of from a
-- status the payout row can get stuck in. A payout reserves float only while
-- the withdrawal that will actually pay the landlord is still alive.
--
-- Deliberately conservative: a payout whose withdrawal already SETTLED
-- ('completed'/'paid') keeps reserving. Either the float was debited (the
-- reservation is a harmless double-count that under-shows float) or it was not
-- (the balance is overstated and the reservation compensates). Under-showing is
-- the safe failure mode, so those are flagged for Financial Ops rather than
-- auto-released. See `public.agent_lp_float_holds`.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Reservation-aware available float, now linkage-aware.
CREATE OR REPLACE FUNCTION public.get_agent_lp_float_available(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    0,
    COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent_id), 0)
    - COALESCE((
        SELECT SUM(lp.amount)
        FROM public.landlord_payouts lp
        WHERE lp.agent_id = p_agent_id
          AND lp.status IN ('otp_verified','pending_merchant_payout')
          AND (
            -- Backed by a merchant withdrawal that is still alive (queued,
            -- claimed, approved, processing …) or already settled.
            EXISTS (
              SELECT 1
              FROM public.withdrawal_requests wr
              WHERE wr.landlord_payout_id = lp.id
                AND wr.status NOT IN
                  ('rejected','cancelled','failed','expired','reversed')
            )
            -- Or not yet linked to a withdrawal at all and young enough that
            -- the disburse call could still be in flight. Landlord payouts are
            -- same-day operations; anything older than a day is stuck, not
            -- pending, and must not hold float against later allocations.
            OR (
              NOT EXISTS (
                SELECT 1 FROM public.withdrawal_requests wr
                WHERE wr.landlord_payout_id = lp.id
              )
              AND lp.created_at > now() - interval '24 hours'
            )
          )
      ), 0)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_lp_float_available(uuid)
  TO authenticated, service_role;

-- 2) Diagnostic: exactly what is holding each agent's landlord payout float,
--    and whether that hold is live, stale (auto-released by the rule above), or
--    settled-but-stuck (needs a Financial Ops decision).
-- security_invoker: the view must NOT bypass RLS on landlord_payouts /
-- withdrawal_requests, or any authenticated user could read every agent's
-- holds by dropping the agent_id filter. Inside the SECURITY DEFINER
-- reconciler below it still sees all rows, which is what that function needs.
DROP VIEW IF EXISTS public.agent_lp_float_holds;
CREATE VIEW public.agent_lp_float_holds
WITH (security_invoker = true) AS
SELECT
  lp.id                AS payout_id,
  lp.agent_id,
  lp.landlord_id,
  lp.landlord_name,
  lp.landlord_phone,
  lp.rent_request_id,
  lp.amount,
  lp.status            AS payout_status,
  lp.created_at        AS payout_created_at,
  wr.id                AS withdrawal_id,
  wr.status            AS withdrawal_status,
  CASE
    WHEN wr.id IS NULL AND lp.created_at > now() - interval '24 hours'
      THEN 'holding_unlinked'
    WHEN wr.id IS NULL
      THEN 'released_orphaned'
    WHEN wr.status IN ('rejected','cancelled','failed','expired','reversed')
      THEN 'released_dead_withdrawal'
    WHEN wr.status IN ('completed','paid')
      THEN 'holding_settled_needs_review'
    ELSE 'holding_live'
  END AS hold_state
FROM public.landlord_payouts lp
LEFT JOIN LATERAL (
  SELECT w.id, w.status
  FROM public.withdrawal_requests w
  WHERE w.landlord_payout_id = lp.id
  ORDER BY w.created_at DESC
  LIMIT 1
) wr ON TRUE
WHERE lp.status IN ('otp_verified','pending_merchant_payout');

GRANT SELECT ON public.agent_lp_float_holds TO authenticated, service_role;

-- 3) Reconciliation: close out payout rows whose backing withdrawal is dead or
--    missing so the landlord becomes payable again and the allocation reopens.
--    NOTHING is credited back — these rows were never debited from the float
--    (the debit happens in `approve-withdrawal` at settlement time), so a
--    refund here would over-credit the agent.
CREATE OR REPLACE FUNCTION public.reconcile_stuck_landlord_payout_holds(
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_closed int := 0;
  v_flagged int := 0;
  r RECORD;
BEGIN
  -- Finance/exec roles may reconcile anyone; an agent may reconcile only their
  -- own holds. Safe either way: only demonstrably dead holds are touched.
  IF NOT (
    public.has_role(v_caller, 'cfo')
    OR public.has_role(v_caller, 'coo')
    OR public.has_role(v_caller, 'ceo')
    OR public.has_role(v_caller, 'operations')
    OR public.has_role(v_caller, 'super_admin')
    OR (p_agent_id IS NOT NULL AND p_agent_id = v_caller)
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  FOR r IN
    SELECT * FROM public.agent_lp_float_holds
    WHERE (p_agent_id IS NULL OR agent_id = p_agent_id)
      AND hold_state IN ('released_orphaned','released_dead_withdrawal')
  LOOP
    UPDATE public.landlord_payouts
    SET status = 'failed',
        last_error = COALESCE(last_error, '') ||
          CASE WHEN COALESCE(last_error, '') = '' THEN '' ELSE ' | ' END ||
          'Auto-closed: backing merchant withdrawal ' ||
          COALESCE(r.withdrawal_status, 'missing') ||
          '. Landlord Payout Float was never debited.',
        updated_at = now()
    WHERE id = r.payout_id
      AND status IN ('otp_verified','pending_merchant_payout');

    IF FOUND THEN
      v_closed := v_closed + 1;
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (
        v_caller,
        'landlord_payout_hold_released',
        'landlord_payouts',
        r.payout_id,
        'stuck_float_hold',
        jsonb_build_object(
          'agent_id', r.agent_id,
          'amount', r.amount,
          'prior_status', r.payout_status,
          'withdrawal_id', r.withdrawal_id,
          'withdrawal_status', r.withdrawal_status,
          'refunded', false
        )
      );
    END IF;
  END LOOP;

  -- Settled-but-stuck rows are NOT auto-released; they need a float-debit
  -- check by Financial Ops. Record them so they surface instead of rotting.
  FOR r IN
    SELECT * FROM public.agent_lp_float_holds
    WHERE (p_agent_id IS NULL OR agent_id = p_agent_id)
      AND hold_state = 'holding_settled_needs_review'
  LOOP
    v_flagged := v_flagged + 1;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (
      v_caller,
      'landlord_payout_settled_but_stuck',
      'landlord_payouts',
      r.payout_id,
      'needs_finops_review',
      jsonb_build_object(
        'agent_id', r.agent_id,
        'amount', r.amount,
        'payout_status', r.payout_status,
        'withdrawal_id', r.withdrawal_id,
        'withdrawal_status', r.withdrawal_status
      )
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'closed', v_closed, 'flagged_for_review', v_flagged);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_stuck_landlord_payout_holds(uuid)
  TO authenticated, service_role;

-- 4) One-time cleanup of the backlog that has accumulated to date. Same rule,
--    same no-refund guarantee, run as the system (no auth.uid()).
DO $cleanup$
DECLARE
  r RECORD;
  v_closed int := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.agent_lp_float_holds
    WHERE hold_state IN ('released_orphaned','released_dead_withdrawal')
  LOOP
    UPDATE public.landlord_payouts
    SET status = 'failed',
        last_error = COALESCE(last_error, '') ||
          CASE WHEN COALESCE(last_error, '') = '' THEN '' ELSE ' | ' END ||
          'Auto-closed by migration 20260826130000: backing merchant withdrawal ' ||
          COALESCE(r.withdrawal_status, 'missing') ||
          '. Landlord Payout Float was never debited.',
        updated_at = now()
    WHERE id = r.payout_id
      AND status IN ('otp_verified','pending_merchant_payout');

    IF FOUND THEN
      v_closed := v_closed + 1;
      INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
      VALUES (
        'landlord_payout_hold_released',
        'landlord_payouts',
        r.payout_id,
        'migration_backfill',
        jsonb_build_object(
          'agent_id', r.agent_id,
          'amount', r.amount,
          'prior_status', r.payout_status,
          'withdrawal_id', r.withdrawal_id,
          'withdrawal_status', r.withdrawal_status,
          'refunded', false
        )
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'Released % stuck landlord payout float holds', v_closed;
END
$cleanup$;
