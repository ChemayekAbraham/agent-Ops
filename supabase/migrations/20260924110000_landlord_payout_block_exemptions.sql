-- CTO Platform Controls: "Block landlord payouts from queue" — selective allow.
--
-- Ask (2026-09-24): with the block ON, the CTO must be able to SEE the
-- landlord payouts it is holding back and ALLOW specific ones through to the
-- Merchant Agent Payout Queue while the rest stay blocked.
--
-- Design: a per-withdrawal exemption stamp on withdrawal_requests
-- (landlord_block_exempt_at / _by). A landlord row is queue-blocked iff
--   landlord_payout_id IS NOT NULL
--   AND landlord_block_exempt_at IS NULL
--   AND landlord_payouts_blocked_from_queue()
-- — one predicate, public.landlord_payout_queue_blocked(), now used by every
-- server read that previously checked the flag alone (doc 37's three, plus the
-- landlord priority hold). The client fence (AgentCashPayoutsTab
-- isQueueRowClientEligible) applies the same rule.
--
-- The stamp has no effect while the block is OFF.
--
-- The view and claim_withdrawal_verified / get_withdrawal_claim_status are
-- patched IN PLACE from their live definitions (string replace + assert),
-- not re-declared from a repo copy: repo migrations drift from production
-- (docs 06/07/17/61 — 20260916150000 already silently dropped the payouts
-- freeze check once by re-declaring claim_withdrawal_verified wholesale).

-- 1. Exemption stamp --------------------------------------------------------
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS landlord_block_exempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS landlord_block_exempt_by uuid;

COMMENT ON COLUMN public.withdrawal_requests.landlord_block_exempt_at IS
  'Set by the CTO via set_landlord_payout_block_exemption(): this landlord payout stays visible/claimable in the merchant queue even while the "Block landlord payouts from queue" control (landlord_payouts_blocked) is ON. No effect while the control is OFF.';

-- 2. Single row-level predicate ---------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_payout_queue_blocked(
  p_landlord_payout_id uuid,
  p_exempt_at timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select p_landlord_payout_id is not null
     and p_exempt_at is null
     and public.landlord_payouts_blocked_from_queue();
$$;

-- 3. Patch live enforcement points in place ---------------------------------
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- 3a. Queue view.
  v_def := pg_get_viewdef('public.v_merchant_payout_queue'::regclass, true);
  v_new := replace(v_def,
    '(landlord_payout_id IS NULL OR NOT landlord_payouts_blocked_from_queue())',
    'NOT landlord_payout_queue_blocked(landlord_payout_id, landlord_block_exempt_at)');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'v_merchant_payout_queue: landlord block predicate not found in live definition';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_merchant_payout_queue AS ' || v_new;

  -- 3b. Claim RPC, section C.
  v_def := pg_get_functiondef('public.claim_withdrawal_verified(uuid,text,text)'::regprocedure);
  v_new := replace(v_def,
    'OR (v_w.landlord_payout_id IS NOT NULL AND public.landlord_payouts_blocked_from_queue())',
    'OR public.landlord_payout_queue_blocked(v_w.landlord_payout_id, v_w.landlord_block_exempt_at)');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'claim_withdrawal_verified: landlord block predicate not found in live definition';
  END IF;
  EXECUTE v_new;

  -- 3c. Claim-status RPC (narrow SELECT list, so add the column too).
  v_def := pg_get_functiondef('public.get_withdrawal_claim_status(uuid)'::regprocedure);
  v_new := replace(v_def,
    'hidden_from_merchant_queue, landlord_payout_id' || chr(10),
    'hidden_from_merchant_queue, landlord_payout_id, landlord_block_exempt_at' || chr(10));
  v_new := replace(v_new,
    'AND (v_w.landlord_payout_id IS NULL OR NOT public.landlord_payouts_blocked_from_queue())',
    'AND NOT public.landlord_payout_queue_blocked(v_w.landlord_payout_id, v_w.landlord_block_exempt_at)');
  IF v_new NOT LIKE '%landlord_payout_queue_blocked(v_w.landlord_payout_id, v_w.landlord_block_exempt_at)%'
     OR v_new NOT LIKE '%landlord_payout_id, landlord_block_exempt_at%' THEN
    RAISE EXCEPTION 'get_withdrawal_claim_status: landlord block predicate / select list not found in live definition';
  END IF;
  EXECUTE v_new;
END
$patch$;

-- 3d. Landlord priority hold. Pre-existing gap: with BOTH "Show Landlord
--     Payouts first" and "Block landlord payouts from queue" ON, the oldest
--     *hidden* landlord row still held every other claim server-side
--     (CLAIM_PRIORITY_BLOCKED on a payout the merchant can't even see), while
--     the client already drops the hold when blocked (doc 37). Now: blocked
--     rows never hold the queue; allowed (exempt) landlord rows still do.
CREATE OR REPLACE FUNCTION public.assert_no_urgent_landlord_priority(p_withdrawal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text;
  v_block uuid;
  v_enforced boolean;
BEGIN
  SELECT enabled INTO v_enforced
    FROM public.treasury_controls
   WHERE control_key = 'landlord_payout_priority';

  IF COALESCE(v_enforced, true) = false THEN
    RETURN NULL;
  END IF;

  SELECT reason INTO v_reason
    FROM public.withdrawal_requests WHERE id = p_withdrawal_id;

  IF COALESCE(v_reason, '') LIKE 'Landlord float payout%' THEN
    RETURN NULL;
  END IF;

  SELECT w.id INTO v_block
    FROM public.withdrawal_requests w
   WHERE COALESCE(w.reason, '') LIKE 'Landlord float payout%'
     AND w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
     AND NOT public.landlord_payout_queue_blocked(w.landlord_payout_id, w.landlord_block_exempt_at)
   ORDER BY w.created_at ASC
   LIMIT 1
   FOR UPDATE;

  RETURN v_block;
END;
$function$;

-- 4. CTO list: every open, unclaimed landlord payout + its allow state -------
CREATE OR REPLACE FUNCTION public.get_landlord_payout_block_queue()
RETURNS TABLE (
  withdrawal_id uuid,
  landlord_payout_id uuid,
  amount numeric,
  created_at timestamptz,
  status text,
  landlord_name text,
  landlord_phone text,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  mobile_money_number text,
  mobile_money_name text,
  payout_method text,
  exempt_at timestamptz,
  exempt_by uuid,
  exempt_by_name text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role)
       OR public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT w.id, w.landlord_payout_id, w.amount, w.created_at, w.status,
         lp.landlord_name, lp.landlord_phone,
         w.user_id, pa.full_name, pa.phone,
         w.mobile_money_number, w.mobile_money_name, w.payout_method,
         w.landlord_block_exempt_at, w.landlord_block_exempt_by, pe.full_name
    FROM public.withdrawal_requests w
    LEFT JOIN public.landlord_payouts lp ON lp.id = w.landlord_payout_id
    LEFT JOIN public.profiles pa ON pa.id = w.user_id
    LEFT JOIN public.profiles pe ON pe.id = w.landlord_block_exempt_by
   WHERE w.landlord_payout_id IS NOT NULL
     AND w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.hidden_from_merchant_queue IS NOT TRUE
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
   ORDER BY w.created_at ASC;
END;
$$;

-- 5. CTO allow / re-block ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(
  p_withdrawal_ids uuid[],
  p_allow boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- Only open, unclaimed landlord rows. A row already claimed by a merchant
  -- is left alone: re-blocking must never yank a payout mid-payment.
  WITH upd AS (
    UPDATE public.withdrawal_requests w
       SET landlord_block_exempt_at = CASE WHEN p_allow THEN now() ELSE NULL END,
           landlord_block_exempt_by = CASE WHEN p_allow THEN v_uid ELSE NULL END
     WHERE w.id = ANY (p_withdrawal_ids)
       AND w.landlord_payout_id IS NOT NULL
       AND w.assigned_cashout_agent_id IS NULL
       AND w.processed_at IS NULL
       AND w.fin_ops_reference IS NULL
       AND (w.landlord_block_exempt_at IS NULL) = p_allow
    RETURNING w.id
  )
  SELECT array_agg(id) INTO v_ids FROM upd;

  IF v_ids IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid,
           CASE WHEN p_allow THEN 'landlord_payout_block_exempt' ELSE 'landlord_payout_block_unexempt' END,
           CASE WHEN p_allow THEN 'Allowed landlord payout through queue block' ELSE 'Re-blocked landlord payout' END,
           'withdrawal_requests', id::text,
           jsonb_build_object('landlord_payouts_blocked', public.landlord_payouts_blocked_from_queue())
      FROM unnest(v_ids) AS id;
  END IF;

  RETURN COALESCE(cardinality(v_ids), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_landlord_payout_block_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_block_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_payout_queue_blocked(uuid, timestamptz) TO authenticated;
