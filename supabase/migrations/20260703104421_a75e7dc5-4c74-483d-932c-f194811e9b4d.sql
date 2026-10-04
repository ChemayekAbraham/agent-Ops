CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor_at       timestamptz;
  v_is_agent        boolean := false;
  v_withdrawable_raw numeric := 0;
  v_float_raw       numeric := 0;
  v_advance_raw     numeric := 0;
  v_holds           numeric := 0;
  v_withdrawable    numeric := 0;
  v_float           numeric := 0;
  v_advance         numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0
    );
  END IF;

  SELECT anchor_at INTO v_anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id AND role = 'agent' AND COALESCE(enabled, true) = true
  ) INTO v_is_agent;

  WITH routed AS (
    SELECT
      CASE WHEN gl.direction IN ('cash_in','credit') THEN 1 ELSE -1 END AS sign,
      gl.amount,
      CASE
        WHEN gl.wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
          THEN gl.wallet_bucket
        WHEN gl.wallet_bucket IS NULL THEN
          CASE
            WHEN v_is_agent AND gl.direction IN ('cash_in','credit')
                 AND gl.category IN (
                   'cfo_direct_credit','pool_capital_received','partner_funding',
                   'supporter_capital','supporter_rent_fund','manager_credit'
                 ) THEN 'float'
            WHEN v_is_agent AND gl.direction IN ('cash_out','debit')
                 AND gl.category IN (
                   'agent_proxy_investment','coo_proxy_investment',
                   'pending_portfolio_topup','proxy_partner_withdrawal',
                   'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
                 ) THEN 'float'
            WHEN gl.category IN (
                   'agent_float_deposit','agent_float_assignment','agent_float_topup',
                   'agent_float_funding','agent_float_used_for_rent','agent_float_used',
                   'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
                 ) THEN 'float'
            WHEN gl.category IN ('agent_advance_credit','salary_advance')
                 AND gl.direction IN ('cash_in','credit') THEN 'advance_credit'
            WHEN gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
                 AND gl.direction IN ('cash_out','debit') THEN 'advance_repayment'
            ELSE 'withdrawable'
          END
        ELSE NULL
      END AS bucket
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction IN ('cash_in','credit','cash_out','debit')
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction IN ('debit','cash_out')
        )
      )
      AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign * amount ELSE 0 END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw
  FROM routed;

  -- Pending holds: hold in-flight requests until the wallet debit actually exists.
  SELECT COALESCE(SUM(wr.amount), 0)
    INTO v_holds
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending','requested','manager_approved','processing','approved')
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
    )
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id;

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_holds);
  v_float        := GREATEST(0, v_float_raw);
  v_advance      := GREATEST(0, v_advance_raw);

  RETURN jsonb_build_object(
    'user_id',         p_user_id,
    'withdrawable',    v_withdrawable,
    'float_balance',   v_float,
    'advance_balance', v_advance,
    'pending_holds',   v_holds,
    'total_visible',   v_withdrawable + v_float
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable_raw numeric := 0;
  _holds            numeric := 0;
  _anchor_at        timestamptz;
  _is_agent         boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role = 'agent'
      AND COALESCE(enabled, true) = true
  ) INTO _is_agent;

  SELECT COALESCE(SUM(
           CASE
             WHEN gl.direction IN ('cash_in','credit')  THEN  1
             WHEN gl.direction IN ('cash_out','debit')  THEN -1
             ELSE 0
           END * gl.amount
         ), 0)
    INTO _withdrawable_raw
  FROM public.general_ledger gl
  WHERE gl.user_id = p_user_id
    AND gl.ledger_scope = 'wallet'
    AND gl.direction IN ('cash_in','credit','cash_out','debit')
    AND (
      gl.classification IS NULL
      OR gl.classification = 'production'
      OR (
        gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.direction IN ('debit','cash_out')
      )
    )
    AND (_anchor_at IS NULL OR gl.created_at >= _anchor_at)
    AND (
      gl.wallet_bucket = 'withdrawable'
      OR (
        gl.wallet_bucket IS NULL
        AND NOT (
          _is_agent
          AND gl.direction IN ('cash_in','credit')
          AND gl.category IN (
            'cfo_direct_credit','pool_capital_received','partner_funding',
            'supporter_capital','supporter_rent_fund','manager_credit'
          )
        )
        AND NOT (
          _is_agent
          AND gl.direction IN ('cash_out','debit')
          AND gl.category IN (
            'agent_proxy_investment','coo_proxy_investment',
            'pending_portfolio_topup','proxy_partner_withdrawal',
            'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
          )
        )
        AND gl.category NOT IN (
          'agent_float_deposit','agent_float_assignment','agent_float_topup',
          'agent_float_funding','agent_float_used_for_rent','agent_float_used',
          'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
        )
        AND NOT (
          gl.category IN ('agent_advance_credit','salary_advance')
          AND gl.direction IN ('cash_in','credit')
        )
        AND NOT (
          gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
          AND gl.direction IN ('cash_out','debit')
        )
      )
    );

  -- Pending holds: hold in-flight requests until the wallet debit actually exists.
  SELECT COALESCE(SUM(wr.amount), 0)
    INTO _holds
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending','requested','manager_approved','processing','approved')
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
    )
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id;

  RETURN GREATEST(0, COALESCE(_withdrawable_raw, 0) - COALESCE(_holds, 0));
END;
$function$;

CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
 WITH anchors AS (
         SELECT wallet_fresh_start_anchors.user_id,
            wallet_fresh_start_anchors.anchor_at
           FROM wallet_fresh_start_anchors
        ), ledger AS (
         SELECT gl.user_id,
            gl.category,
            gl.direction,
            gl.amount,
            gl.wallet_bucket
           FROM general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
          WHERE gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text]))) AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
        ), routed_explicit AS (
         SELECT ledger.user_id,
            ledger.amount,
            ledger.wallet_bucket AS bucket,
                CASE
                    WHEN ledger.direction = ANY (ARRAY['cash_in'::text, 'credit'::text]) THEN 1
                    WHEN ledger.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]) THEN '-1'::integer
                    ELSE 0
                END AS sign
           FROM ledger
          WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable'::text, 'float'::text, 'advance_credit'::text, 'advance_repayment'::text])
        ), routed_category AS (
         SELECT l.user_id,
            l.amount,
            r.bucket,
            r.sign
           FROM ledger l
             CROSS JOIN LATERAL wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
          WHERE l.wallet_bucket IS NULL
        ), routed AS (
         SELECT routed_explicit.user_id,
            routed_explicit.amount,
            routed_explicit.bucket,
            routed_explicit.sign
           FROM routed_explicit
        UNION ALL
         SELECT routed_category.user_id,
            routed_category.amount,
            routed_category.bucket,
            routed_category.sign
           FROM routed_category
        ), buckets AS (
         SELECT routed.user_id,
            sum(
                CASE
                    WHEN routed.bucket = 'withdrawable'::text THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS withdrawable_raw,
            sum(
                CASE
                    WHEN routed.bucket = 'float'::text THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS float_raw,
            sum(
                CASE
                    WHEN routed.bucket = ANY (ARRAY['advance_credit'::text, 'advance_repayment'::text]) THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS advance_raw
           FROM routed
          GROUP BY routed.user_id
        ), holds AS (
         SELECT
                CASE
                    WHEN withdrawal_requests.proxy_partner_id IS NOT NULL AND withdrawal_requests.agent_id IS NOT NULL THEN withdrawal_requests.agent_id
                    ELSE withdrawal_requests.user_id
                END AS user_id,
            COALESCE(sum(withdrawal_requests.amount), 0::numeric) AS pending_holds
           FROM withdrawal_requests
          WHERE (withdrawal_requests.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text, 'approved'::text])) AND (NOT (EXISTS ( SELECT 1 FROM general_ledger g WHERE g.source_table = 'withdrawal_requests' AND g.source_id = withdrawal_requests.id AND g.ledger_scope = 'wallet' AND (g.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]))))) AND (withdrawal_requests.reason IS NULL OR withdrawal_requests.reason !~~ 'Landlord float payout%'::text)
          GROUP BY (
                CASE
                    WHEN withdrawal_requests.proxy_partner_id IS NOT NULL AND withdrawal_requests.agent_id IS NOT NULL THEN withdrawal_requests.agent_id
                    ELSE withdrawal_requests.user_id
                END)
        ), universe AS (
         SELECT wallets_physical.user_id
           FROM wallets_physical
        UNION
         SELECT buckets.user_id
           FROM buckets
        UNION
         SELECT holds.user_id
           FROM holds
        )
 SELECT u.user_id,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
    GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
    GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
    COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible
   FROM universe u
     LEFT JOIN buckets b ON b.user_id = u.user_id
     LEFT JOIN holds h ON h.user_id = u.user_id;