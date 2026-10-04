-- A tenant's outstanding balance moves through the CFO route or not at all.
--
-- 20260928140000 put every ops RPC behind CFO approval. That is worth nothing
-- while the same columns can be PATCHed straight from the client, and they can:
--
--   * RLS policy "Managers can update requests" is USING has_role('manager')
--     with WITH CHECK **null** — no column restriction whatsoever. 31 accounts
--     hold `manager`, and several of them are field agents.
--   * "Supporters can fund requests" is the same shape for any approved plan.
--   * "Agents and managers can verify unverified requests" restricts the AGENT
--     branch and leaves the manager branch open.
--   * `guard_rent_request_agent_updates` — the trigger that rewrites
--     NEW.amount_repaid back to OLD — returns NEW immediately for
--     `is_sensitive_field_editor` or `manager`, so it never sees these writes.
--   * The Agent Allocation Report has an inline editor that writes
--     `amount_repaid` directly with no reason, no audit row and no approval.
--
-- Plan 077695ca is what that looks like in practice: ~1,080,000 collected, read
-- 5,340,000 repaid on 21 September, nothing in `audit_logs`, and 5,340,000 of
-- receivable written off on the 22nd because the plan said it was settled.
--
-- WHY THIS FREEZES `amount_repaid` AND NOT ALL FOUR FINANCIAL COLUMNS
--
-- A blanket freeze was the first instinct and it is wrong. Three live screens
-- legitimately edit the rent plan AMOUNT by direct write — EditApprovedRentDialog
-- (agent, with guarantor re-consent), the RentPipelineQueue inline editors
-- (pre-funding review) and the pipeline's rent/duration recompute. Breaking
-- those to close a balance hole would trade a real workflow for the wrong fix.
--
-- What must never move by direct write is what the TENANT OWES. `amount_repaid`
-- is frozen everywhere; `rent_amount` and the schedule derived from it keep
-- their existing routes. `enforce_rent_request_formula` already recomputes
-- access_fee, request_fee, total_repayment and daily_repayment from rent_amount
-- and duration on every write, so nobody chooses the totals by hand anyway.
--
-- THE AGENT RULE
--
-- Agents never touch the outstanding balance — that is now structural rather
-- than a matter of which policy happens to apply. They may change the rent plan
-- amount in exactly two situations:
--
--   * the plan is `rejected` — they are fixing it to resubmit;
--   * it is a `renewal` still in review (`pending` / `service_center_review`).
--
-- Outside those two, every financial column is frozen for an agent, which is
-- what the policies already did. This is a narrow widening, not a loosening:
-- before this migration an agent could not correct the amount on a rejected
-- plan at all, because `rent_request_financials_unchanged` covers all four
-- columns together.

-- 1. What the tenant owes cannot move by a direct write ------------------
CREATE OR REPLACE FUNCTION public.rent_request_balance_unchanged(
  _id uuid, _amount_repaid numeric)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.rent_requests r
     WHERE r.id = _id
       AND COALESCE(r.amount_repaid, 0) IS DISTINCT FROM COALESCE(_amount_repaid, 0)
  )
$function$;

COMMENT ON FUNCTION public.rent_request_balance_unchanged(uuid, numeric) IS
  'True when a direct client write leaves amount_repaid alone. SECURITY DEFINER '
  'RPCs are unaffected — they bypass RLS — so the CFO-approved route still '
  'moves the balance. Nothing else may.';

-- 2. When an agent may change the rent plan amount -----------------------
CREATE OR REPLACE FUNCTION public.rent_request_agent_financials_ok(
  _id uuid, _rent_amount numeric, _total_repayment numeric,
  _daily_repayment numeric, _amount_repaid numeric)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    -- Never, under any status: an agent does not move what a tenant owes.
    public.rent_request_balance_unchanged(_id, _amount_repaid)
    AND (
      -- Rejected, or a renewal still in review: the amount may be corrected.
      EXISTS (
        SELECT 1 FROM public.rent_requests r
         WHERE r.id = _id
           AND (r.status = 'rejected'
                OR (r.registration_type = 'renewal'
                    AND r.status IN ('pending', 'service_center_review')))
      )
      -- Otherwise the terms are frozen, exactly as before.
      OR public.rent_request_financials_unchanged(
           _id, _rent_amount, _total_repayment, _daily_repayment, _amount_repaid)
    )
$function$;

COMMENT ON FUNCTION public.rent_request_agent_financials_ok(uuid, numeric, numeric, numeric, numeric) IS
  'Agent write rule for rent request financials: amount_repaid frozen always; '
  'rent plan amount editable only on a rejected plan or a renewal still in review.';

-- 3. Re-point the agent policies -----------------------------------------
DROP POLICY IF EXISTS "Agents can verify their requests" ON public.rent_requests;
CREATE POLICY "Agents can verify their requests"
  ON public.rent_requests FOR UPDATE
  USING (public.has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid())
  WITH CHECK (
    public.has_role(auth.uid(), 'agent'::app_role)
    AND agent_id = auth.uid()
    AND status = ANY (ARRAY['pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'])
    AND public.rent_request_agent_financials_ok(id, rent_amount, total_repayment, daily_repayment, amount_repaid)
  );

DROP POLICY IF EXISTS "Agents can edit own rejected requests" ON public.rent_requests;
CREATE POLICY "Agents can edit own rejected requests"
  ON public.rent_requests FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'agent'::app_role)
    AND agent_id = auth.uid()
    AND status = ANY (ARRAY['rejected','deleted_by_agent'])
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'agent'::app_role)
    AND agent_id = auth.uid()
    AND public.rent_request_agent_financials_ok(id, rent_amount, total_repayment, daily_repayment, amount_repaid)
  );

DROP POLICY IF EXISTS "Agents and managers can verify unverified requests" ON public.rent_requests;
CREATE POLICY "Agents and managers can verify unverified requests"
  ON public.rent_requests FOR UPDATE
  USING (
    agent_verified = false
    AND status = ANY (ARRAY['pending','approved'])
    AND (
      public.has_role(auth.uid(), 'manager'::app_role)
      OR ((public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'senior_agent'::app_role))
          AND (agent_id IS NULL OR agent_id = auth.uid() OR agent_verified_by = auth.uid()))
    )
  )
  WITH CHECK (
    -- The manager branch was unrestricted. It is not any more.
    (public.has_role(auth.uid(), 'manager'::app_role)
     AND public.rent_request_balance_unchanged(id, amount_repaid))
    OR ((public.has_role(auth.uid(), 'agent'::app_role) OR public.has_role(auth.uid(), 'senior_agent'::app_role))
        AND status = ANY (ARRAY['pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'])
        AND public.rent_request_agent_financials_ok(id, rent_amount, total_repayment, daily_repayment, amount_repaid))
  );

-- 4. The two policies that had no WITH CHECK at all ----------------------
DROP POLICY IF EXISTS "Managers can update requests" ON public.rent_requests;
CREATE POLICY "Managers can update requests"
  ON public.rent_requests FOR UPDATE
  USING (public.has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (
    public.has_role(auth.uid(), 'manager'::app_role)
    AND public.rent_request_balance_unchanged(id, amount_repaid)
  );

DROP POLICY IF EXISTS "Supporters can fund requests" ON public.rent_requests;
CREATE POLICY "Supporters can fund requests"
  ON public.rent_requests FOR UPDATE
  USING (public.has_role(auth.uid(), 'supporter'::app_role) AND status = 'approved'::text)
  WITH CHECK (
    public.has_role(auth.uid(), 'supporter'::app_role)
    AND public.rent_request_balance_unchanged(id, amount_repaid)
  );

-- 5. Post-condition ------------------------------------------------------
DO $check$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_policy
   WHERE polrelid = 'public.rent_requests'::regclass
     AND polcmd IN ('w', '*')
     AND polwithcheck IS NULL;

  IF v_open > 0 THEN
    RAISE EXCEPTION 'Still % UPDATE policy/policies on rent_requests with no WITH CHECK', v_open;
  END IF;
END
$check$;
