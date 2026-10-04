-- =========================================================================
-- Two fixes, 2026-08-18:
--
-- 1) get_merchant_float_positions() (powers the Financial Ops Overview
--    "Money With Merchant Agents" board) lost its per-call read-repair on
--    2026-08-14 -- added at 14:33:24, silently dropped 13 minutes later by
--    an unrelated rewrite at 14:56:34, never restored since. Freshness has
--    depended entirely on the 2-minute flush-dirty-wallet-projections cron
--    ever since, instead of always being correct on load. Restored below,
--    same pattern already proven in the 14:33:24 migration and still used
--    today by get_wallets_batch / get_user_wallet_view.
--
-- 2) Incident report P1 (docs/investigations/Merchant_Float_Incident_Report_2026-08-17.md,
--    Section 4): the zero-floor clamp on float_balance silently discards
--    any debit that would take a desk negative -- no error, no record.
--    wallet_balances_projection never stored the true unfloored signed
--    figure, so nothing could ever recover the discarded amount. Fixed by:
--      - storing float_balance_raw (the true signed net) on the projection
--        row alongside the existing floored float_balance;
--      - logging a row to wallet_overdraw_events (existing table, already
--        wired into the daily acceptance-test monitor) whenever the raw
--        figure is negative and has changed since the last write, so a
--        real deficit is never silent again;
--      - exposing clamped_shortfall_amount from get_merchant_float_positions
--        so the board can show it instead of hiding it.
--
--    Bonus finding while wiring this up: get_merchant_float_positions()'s
--    own "clamp_artifact" detection (the mechanism behind the 16-Aug
--    "evidenced only" split) was silently INERT. Its raw_float_net CTE read
--    GREATEST(0, wallet_balances_projection.float_balance) -- but
--    float_balance is ALREADY floored at 0 by refresh_wallet_projection_for,
--    so it was comparing the floored cache against itself a second time.
--    clamp_artifact = LEAST(ledger_float, GREATEST(0, ledger_float - net))
--    was therefore always exactly 0, regardless of how much was actually
--    clamped. Fixed by reading the new float_balance_raw column instead.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 0) Schema: the true signed (unfloored) float net, alongside the existing
--    floored float_balance.
-- -------------------------------------------------------------------------
ALTER TABLE public.wallet_balances_projection
  ADD COLUMN IF NOT EXISTS float_balance_raw numeric NOT NULL DEFAULT 0;

-- -------------------------------------------------------------------------
-- 1) refresh_wallet_projection_for: store the raw signed float net, and log
--    (not silently discard) whenever it goes negative.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_wallet_projection_for(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_withdrawable_raw numeric := 0;
  v_float_raw numeric := 0;
  v_advance_raw numeric := 0;
  v_restricted_held numeric := 0;
  v_pending_holds numeric := 0;
  v_withdrawable numeric := 0;
  v_float_balance numeric := 0;
  v_advance_balance numeric := 0;
  v_total_visible numeric := 0;
  v_prior_float_raw numeric;
  v_prior_float_balance numeric;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT float_balance_raw, float_balance
    INTO v_prior_float_raw, v_prior_float_balance
  FROM public.wallet_balances_projection
  WHERE user_id = p_user_id;

  WITH anchor AS (
    SELECT a.anchor_at
    FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id
    LIMIT 1
  ), ledger AS (
    SELECT
      gl.user_id,
      gl.category,
      gl.direction,
      gl.amount,
      gl.wallet_bucket,
      gl.maturity_met,
      gl.maturity_expired,
      gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      AND NOT (
        gl.source_table = 'commission_engine'
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
            AND cal.source_id = gl.source_id::text
        )
      )
      AND NOT (
        gl.source_table = 'commission_engine_reversal'
        AND gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.amount = 10000
        AND EXISTS (
          SELECT 1
          FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = gl.user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
        )
      )
  ), routed_explicit AS (
    SELECT
      l.user_id,
      l.amount,
      l.wallet_bucket AS bucket,
      CASE
        WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
        WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
        ELSE 0
      END AS sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
  ), routed_category AS (
    SELECT
      l.user_id,
      l.amount,
      r.bucket,
      r.sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ), routed AS (
    SELECT * FROM routed_explicit
    UNION ALL
    SELECT * FROM routed_category
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN bucket = 'withdrawable'
       AND direction = ANY (ARRAY['cash_in','credit'])
       AND (
         maturity_expired = true
         OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now()))
       )
      THEN amount
      ELSE 0
    END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw, v_restricted_held
  FROM routed;

  SELECT COALESCE(SUM(wr.amount), 0)
  INTO v_pending_holds
  FROM public.withdrawal_requests wr
  WHERE (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id
    AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND NOT EXISTS (
      SELECT 1
      FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests'
        AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet'
        AND g.direction = ANY (ARRAY['cash_out','debit'])
    );

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_restricted_held - v_pending_holds);
  v_float_balance := GREATEST(0, v_float_raw);
  v_advance_balance := GREATEST(0, v_advance_raw);
  v_total_visible := v_withdrawable + v_float_balance;

  INSERT INTO public.wallet_balances_projection AS w (
    user_id,
    withdrawable,
    float_balance,
    float_balance_raw,
    advance_balance,
    pending_holds,
    restricted_held,
    total_visible,
    ledger_version,
    is_dirty,
    dirty_since,
    updated_at
  ) VALUES (
    p_user_id,
    v_withdrawable,
    v_float_balance,
    v_float_raw,
    v_advance_balance,
    v_pending_holds,
    v_restricted_held,
    v_total_visible,
    1,
    false,
    NULL,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET withdrawable = EXCLUDED.withdrawable,
        float_balance = EXCLUDED.float_balance,
        float_balance_raw = EXCLUDED.float_balance_raw,
        advance_balance = EXCLUDED.advance_balance,
        pending_holds = EXCLUDED.pending_holds,
        restricted_held = EXCLUDED.restricted_held,
        total_visible = EXCLUDED.total_visible,
        ledger_version = w.ledger_version + 1,
        is_dirty = false,
        dirty_since = NULL,
        updated_at = now();

  -- Never let a clamp be silent: log it (P1). Only when the raw figure is
  -- actually negative, and only when it CHANGED since the last recompute --
  -- an unrelated ledger write that re-dirties this row and recomputes to the
  -- exact same deficit must not spam a fresh row every time.
  IF v_float_raw < 0 AND v_float_raw IS DISTINCT FROM v_prior_float_raw THEN
    INSERT INTO public.wallet_overdraw_events (
      user_id, attempted_balance, clamped_to,
      float_before, float_after, trigger_op
    ) VALUES (
      p_user_id, v_float_raw, 0,
      COALESCE(v_prior_float_balance, 0), v_float_balance,
      'refresh_wallet_projection_for:float'
    );
  END IF;
END;
$function$;

-- -------------------------------------------------------------------------
-- 2) get_merchant_float_positions: restore the read-repair loop dropped on
--    2026-08-14, fix the self-referential raw_float_net CTE, and surface
--    the hidden deficit as clamped_shortfall_amount.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric, payouts_without_float_evidence numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone, clamp_artifact_amount numeric, evidenced_amount numeric, asserted_only_amount numeric, evidence_status text, clamped_shortfall_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor date;
  v_is_finance boolean;
  v_agent_id uuid;
BEGIN
  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Read-repair every desk agent's wallet projection before this function
  -- trusts wallets.float_balance / float_balance_raw below, so the board can
  -- never surface a stale pre-write figure regardless of the 2-min sweep's
  -- timing. Restores the step dropped 2026-08-14 14:56 (13 minutes after it
  -- was added at 14:33, by an unrelated rewrite).
  FOR v_agent_id IN
    SELECT DISTINCT ca.agent_id
    FROM public.cashout_agents ca
    WHERE ca.agent_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.wallet_balances_projection w
      WHERE w.user_id = v_agent_id AND w.is_dirty = false
    ) THEN
      PERFORM public.wallet_projection_read_repair(v_agent_id);
    END IF;
  END LOOP;

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           COALESCE(p.full_name, '') AS full_name,
           COALESCE(p.phone, '') AS phone,
           right(regexp_replace(COALESCE(ca.float_phone, p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
  ),
  recon AS (
    SELECT r.id, r.desk_id, r.adjustment_type, r.amount, r.evidence_note,
           EXISTS (
             SELECT 1 FROM public.general_ledger g
             WHERE g.source_table = 'merchant_float_reconciliations'
               AND g.source_id = r.id
           ) AS posted
    FROM public.merchant_float_reconciliations r
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(COALESCE(w.processed_at, w.updated_at)) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status = 'completed'
     AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
     AND (w.assigned_cashout_agent_id = d.id OR w.processed_by = d.agent_id)
    GROUP BY d.id
  ),
  float_credits AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.transaction_date) AS last_at
    FROM desks d
    LEFT JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.category IN ('agent_float_deposit', 'agent_float_assignment')
     AND g.classification <> 'admin_correction'
     AND g.transaction_date >= v_anchor
    GROUP BY d.id
  ),
  emails AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.internal_date) AS last_at
    FROM desks d
    LEFT JOIN public.gmail_transactions g
      ON g.direction = 'out'
     AND g.channel IN ('mtn_momo', 'airtel_money')
     AND g.amount IS NOT NULL
     AND d.phone9 <> ''
     AND right(regexp_replace(COALESCE(g.counterparty, ''), '\D', '', 'g'), 9) = d.phone9
     AND g.internal_date >= v_anchor
    GROUP BY d.id
  ),
  adj AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(CASE WHEN r.adjustment_type = 'payout_correction' THEN -r.amount ELSE r.amount END), 0) AS total
    FROM desks d
    LEFT JOIN recon r ON r.desk_id = d.id AND NOT r.posted
    GROUP BY d.id
  ),
  held AS (
    SELECT d.id AS desk_id, COALESCE(GREATEST(w.float_balance, 0), 0) AS ledger_float
    FROM desks d
    LEFT JOIN public.wallets w ON w.user_id = d.agent_id
  ),
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(GREATEST(f.own_cash_principal, 0)), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_payout_funding f
      ON f.agent_id = d.agent_id
     AND f.funding_source IN ('own_cash', 'mixed', 'needs_review')
    GROUP BY d.id
  ),
  -- FIXED: this used to re-read the already-floored wallet_balances_projection.float_balance
  -- (via `wallets`, same source as `held` above) under a GREATEST(0, ...) that was
  -- always a no-op -- comparing the floored cache against itself and making
  -- clamp_artifact permanently 0 regardless of real clamping. Now reads the true
  -- signed net (float_balance_raw) so a real deficit is visible instead of erased.
  raw_float_net AS (
    SELECT d.id AS desk_id,
           COALESCE(wp.float_balance_raw, wp.float_balance, 0) AS net,
           GREATEST(0, -COALESCE(wp.float_balance_raw, 0)) AS clamped_shortfall
    FROM desks d
    LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = d.agent_id
  ),
  provider_evidence AS (
    SELECT d.id AS desk_id, COALESCE(SUM(g.amount), 0) AS total
    FROM desks d
    JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.ledger_scope = 'wallet'
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.classification = 'production'
     AND g.reference_id IS NOT NULL
     AND g.reference_id <> ''
    WHERE EXISTS (
      SELECT 1 FROM public.gmail_transactions t
      WHERE t.transaction_id = g.reference_id
    )
    GROUP BY d.id
  ),
  cfo_evidence AS (
    SELECT r.desk_id, TRUE AS confirmed
    FROM recon r
    WHERE r.posted AND char_length(COALESCE(r.evidence_note, '')) >= 20
    GROUP BY r.desk_id
  ),
  evidence AS (
    SELECT h.desk_id,
           LEAST(h.ledger_float, GREATEST(0, h.ledger_float - r.net)) AS clamp_artifact,
           GREATEST(0, LEAST(h.ledger_float, r.net)) AS supportable,
           CASE WHEN ce.confirmed THEN GREATEST(0, LEAST(h.ledger_float, r.net))
                ELSE COALESCE(pe.total, 0) END AS provider_total,
           r.clamped_shortfall
    FROM held h
    JOIN raw_float_net r ON r.desk_id = h.desk_id
    LEFT JOIN provider_evidence pe ON pe.desk_id = h.desk_id
    LEFT JOIN cfo_evidence ce ON ce.desk_id = h.desk_id
  ),
  evidence_split AS (
    SELECT e.desk_id,
           e.clamp_artifact,
           LEAST(e.provider_total, e.supportable) AS evidenced,
           GREATEST(0, e.supportable - LEAST(e.provider_total, e.supportable)) AS asserted_only,
           e.clamped_shortfall
    FROM evidence e
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total, fc.total + aj.total, fc.total, em.total, aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         hd.ledger_float, hd.ledger_float, aj.total, ub.total,
         pd.last_at, GREATEST(fc.last_at, em.last_at),
         es.clamp_artifact, es.evidenced, es.asserted_only,
         CASE
           WHEN (CASE WHEN es.clamp_artifact > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.evidenced > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.asserted_only > 0 THEN 1 ELSE 0 END) > 1 THEN 'mixed'
           WHEN es.asserted_only > 0 THEN 'asserted_only'
           WHEN es.clamp_artifact > 0 THEN 'clamp_artifact'
           ELSE 'evidenced'
         END::text,
         es.clamped_shortfall
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  JOIN evidence_split es ON es.desk_id = d.id
  ORDER BY hd.ledger_float DESC, GREATEST(pd.total - (fc.total + aj.total), 0) DESC;
END;
$function$;
