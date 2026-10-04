
-- 1) Neutralize the drift detector: detect-only, no writes to the projection.
CREATE OR REPLACE FUNCTION public.detect_wallet_projection_drift(p_sample_size integer DEFAULT 500)
RETURNS TABLE (
  users_checked bigint,
  users_drifted bigint,
  auto_healed bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checked bigint := 0;
  v_drifted bigint := 0;
BEGIN
  WITH sampled AS (
    SELECT user_id
    FROM public.wallet_balances_projection
    ORDER BY updated_at ASC
    LIMIT p_sample_size
  ),
  compared AS (
    SELECT
      p.user_id,
      p.withdrawable AS p_w, p.float_balance AS p_f, p.advance_balance AS p_a,
      s.withdrawable AS s_w, s.float_balance AS s_f, s.advance_balance AS s_a
    FROM public.wallet_balances_projection p
    JOIN sampled ON sampled.user_id = p.user_id
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = p.user_id
  ),
  divergent AS (
    SELECT * FROM compared
    WHERE (COALESCE(p_w,0) - COALESCE(s_w,0)) <> 0
       OR (COALESCE(p_f,0) - COALESCE(s_f,0)) <> 0
       OR (COALESCE(p_a,0) - COALESCE(s_a,0)) <> 0
  ),
  logged AS (
    INSERT INTO public.wallet_projection_drift_alerts
      (user_id, projection_withdrawable, ledger_withdrawable,
       projection_float, ledger_float, projection_advance, ledger_advance, auto_healed)
    SELECT user_id, p_w, COALESCE(s_w,0), p_f, COALESCE(s_f,0), p_a, COALESCE(s_a,0), false
    FROM divergent
    RETURNING user_id
  )
  SELECT
    (SELECT count(*) FROM sampled),
    (SELECT count(*) FROM divergent)
  INTO v_checked, v_drifted;

  -- No auto-heal. Ledger is source of truth; drift must be investigated,
  -- not silently overwritten outside a ledger transaction.
  RETURN QUERY SELECT v_checked, v_drifted, 0::bigint;
END;
$$;

-- 2) Lock down projection writers so only the in-tx triggers can touch it.
REVOKE EXECUTE ON FUNCTION public.refresh_wallet_projection_for(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_wallet_projection_for(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_wallet_projection_for(uuid) FROM service_role;

REVOKE EXECUTE ON FUNCTION public.rebuild_wallet_projection(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rebuild_wallet_projection(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rebuild_wallet_projection(uuid) FROM service_role;

-- Comment as an enforcement note.
COMMENT ON FUNCTION public.refresh_wallet_projection_for(uuid)
  IS 'INTERNAL ONLY. Callable exclusively from ledger/withdrawal-request triggers within the same transaction as the ledger write. Never call from an edge function, RPC, or scheduled job.';
COMMENT ON FUNCTION public.rebuild_wallet_projection(uuid)
  IS 'DISABLED for external callers. Kept for emergency one-off backfill under direct DB access only. The projection is maintained atomically by ledger triggers; never call this on a schedule.';
COMMENT ON FUNCTION public.detect_wallet_projection_drift(integer)
  IS 'Detect-only. Reports drift into wallet_projection_drift_alerts. Does NOT modify the projection — the ledger is authoritative and any divergence must be investigated, not auto-healed.';
