-- delete_portfolio_and_refund: delete a portfolio cleanly in ONE transaction.
--
--   1. cancel it  → the existing triggers release its Landlord Float Pool money
--                   back to free cash and mark its house claims released, so the
--                   houses go back to the queue for others to claim;
--   2. refund     → the principal actually taken from the partner's wallet is
--                   returned to their operational float (balanced ledger group);
--   3. clean up   → its emptied pool records are removed (they would otherwise
--                   block the delete) and the portfolio row is deleted
--                   (remaining claims and dependants cascade).
--
-- It REFUSES, changing nothing, when a plain refund would be wrong:
--   * Returns were paid or compounded, or commissions were paid on it;
--   * top-ups were applied to it;
--   * any of its pool money is out with tenants;
--   * it is a self-support portfolio (tenant / house picks), a split child or a
--     split parent, or redeemed / matured / locked.
-- Older (pre-pool) portfolios are handled too: their pool category log,
-- membership and ceiling-skip rows are removed with them (those rows have no
-- cascade and would otherwise block the delete).
-- Those need redemption or a reviewed correction instead.
--
-- Callers: Partner Operations (is_partner_ops), service_role, or postgres.
-- The COO / Partner Ops portfolio sheet "Delete" button calls this RPC.

-- Membership rows stay immutable except inside this delete.
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_legacy_members_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.portfolio_delete', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'LANDLORD_POOL_LEGACY_MEMBERSHIP_IMMUTABLE';
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_portfolio_and_refund(p_portfolio_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  p         public.investor_portfolios%ROWTYPE;
  v_taken   numeric;
  v_houses  uuid[];
  v_group   uuid;
  v_out     numeric;
  v_left    numeric;
  v_snap    jsonb;
BEGIN
  IF NOT (
       (v_actor IS NOT NULL AND public.is_partner_ops(v_actor))
    OR coalesce(auth.role(), '') = 'service_role'
    OR session_user = 'postgres'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING HINT = 'Only Partner Operations can delete portfolios.';
  END IF;

  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM pg_advisory_xact_lock(hashtext('delete-portfolio-' || p_portfolio_id::text));

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Portfolio not found.');
  END IF;

  -- ── Refusals: anything a plain refund cannot undo correctly ──
  IF p.status NOT IN ('active', 'pending_ops_approval', 'awaiting_partner_details', 'cancelled', 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'status', p.status,
      'message', format('A %s portfolio cannot be deleted. Redeem it instead.', p.status));
  END IF;
  IF p.locked_from_portfolio_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.investor_portfolios c WHERE c.locked_from_portfolio_id = p.id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SPLIT_PORTFOLIO',
      'message', 'This portfolio has been split. Split portfolios cannot be deleted here.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.funder_pending_portfolios f
              WHERE f.portfolio_id = p.id AND f.source IN ('self_managed', 'self_managed_house')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SELF_SUPPORT',
      'message', 'Self-support portfolios (tenant or house picks) cannot be deleted here.');
  END IF;
  IF coalesce(p.total_roi_earned, 0) > 0
     OR EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.source_table = 'investor_portfolios' AND g.source_id::text = p.id::text
                   AND g.category IN ('roi_expense', 'roi_wallet_credit', 'roi_reinvestment',
                                      'partner_commission', 'agent_commission')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RETURNS_OR_COMMISSION_PAID',
      'message', 'Returns or commissions have already been paid on this portfolio. Redeem it instead.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id::text = p.id::text
                AND g.category IN ('pending_portfolio_topup', 'portfolio_topup')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'HAS_TOPUPS',
      'message', 'Top-ups have been applied to this portfolio. Redeem it instead.');
  END IF;
  SELECT coalesce(sum(out_with_tenants), 0) INTO v_out FROM public.landlord_pool_entries WHERE portfolio_id = p.id;
  IF v_out > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MONEY_WITH_TENANTS', 'out_with_tenants', v_out,
      'message', format('UGX %s of this portfolio is out with tenants. It cannot be deleted.', to_char(v_out, 'FM999,999,999,999')));
  END IF;
  IF EXISTS (SELECT 1 FROM public.hr_pay_staff_reinvestments r WHERE r.portfolio_id = p.id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'STAFF_REINVESTMENT',
      'message', 'This portfolio is linked to a staff pay reinvestment and cannot be deleted here.');
  END IF;

  -- Principal actually taken from the wallet (net of any earlier refunds).
  SELECT coalesce(sum(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END), 0)
    INTO v_taken
    FROM public.general_ledger g
   WHERE g.ledger_scope = 'wallet' AND g.category = 'partner_funding'
     AND ((g.source_table = 'investor_portfolios' AND g.source_id::text = p.id::text)
          OR g.idempotency_key LIKE 'portfolio-funding-' || p.id::text || '%'
          OR g.idempotency_key LIKE '%delete-refund-' || p.id::text
          OR (p.portfolio_code IS NOT NULL AND g.reference_id = p.portfolio_code));

  SELECT array_agg(house_id) INTO v_houses FROM public.portfolio_allocations WHERE portfolio_id = p.id;
  v_snap := to_jsonb(p);

  -- 1. Cancel → pool release + house claims released (existing triggers).
  IF p.status NOT IN ('cancelled', 'rejected') THEN
    UPDATE public.investor_portfolios SET status = 'cancelled' WHERE id = p.id;
  END IF;
  UPDATE public.portfolio_allocations
     SET status = 'released', released_at = now(), release_reason = 'portfolio_deleted'
   WHERE portfolio_id = p.id AND status = 'reserved';

  SELECT coalesce(sum(in_pool), 0) INTO v_left FROM public.landlord_pool_entries WHERE portfolio_id = p.id;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'POOL_NOT_RELEASED' USING HINT = format('UGX %s still in the pool for %s', v_left, p.portfolio_code);
  END IF;

  -- 2. Refund the principal taken to the operational float.
  IF v_taken > 0 THEN
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p.investor_id, 'amount', v_taken, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'investor_portfolios', 'source_id', p.id, 'reference_id', p.portfolio_code,
          'description', format('Portfolio %s deleted — principal returned to operational float', p.portfolio_code)),
        jsonb_build_object(
          'amount', v_taken, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', p.id, 'reference_id', p.portfolio_code,
          'linked_party', p.investor_id::text,
          'description', format('Portfolio %s deleted — partner capital returned to wallet', p.portfolio_code))),
      idempotency_key := 'portfolio-delete-refund-' || p.id::text);
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_actor, 'portfolio_deleted_with_refund', 'investor_portfolios', p.id::text,
    'delete_portfolio_and_refund', coalesce(p_reason, 'Portfolio deleted'),
    jsonb_build_object('portfolio', v_snap, 'refunded', v_taken, 'refund_group_id', v_group,
                       'houses_released', to_jsonb(coalesce(v_houses, '{}'::uuid[]))));

  -- 3. Remove the emptied pool records (they block the delete), then delete.
  DELETE FROM public.landlord_pool_movements
   WHERE pool_entry_id IN (SELECT id FROM public.landlord_pool_entries WHERE portfolio_id = p.id);
  DELETE FROM public.landlord_pool_entries WHERE portfolio_id = p.id;
  DELETE FROM public.landlord_pool_exceptions WHERE portfolio_id = p.id;
  DELETE FROM public.landlord_pool_legacy_skips WHERE portfolio_id = p.id;
  DELETE FROM public.landlord_pool_legacy_category_log WHERE portfolio_id = p.id;
  PERFORM set_config('app.portfolio_delete', 'on', true);
  DELETE FROM public.landlord_pool_legacy_members WHERE portfolio_id = p.id;
  PERFORM set_config('app.portfolio_delete', '', true);
  DELETE FROM public.investor_portfolios WHERE id = p.id;

  RETURN jsonb_build_object('ok', true, 'portfolio_code', p.portfolio_code, 'partner_id', p.investor_id,
    'refunded_to_operational_float', v_taken, 'houses_released', coalesce(array_length(v_houses, 1), 0),
    'refund_group_id', v_group);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_portfolio_and_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_portfolio_and_refund(uuid, text) TO authenticated, service_role;
