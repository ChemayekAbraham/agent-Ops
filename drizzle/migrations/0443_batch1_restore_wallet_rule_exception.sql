CREATE OR REPLACE FUNCTION public.wallet_strict_for_user(p_user_id uuid)
 RETURNS TABLE(user_id uuid, withdrawable numeric, float_balance numeric, advance_balance numeric, pending_holds numeric, restricted_held numeric, total_visible numeric, float_balance_signed numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH anchor AS (
    SELECT a.anchor_at FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id LIMIT 1
  ), ledger AS (
    SELECT gl.category, gl.direction, gl.amount, gl.wallet_bucket,
           gl.maturity_met, gl.maturity_expired, gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (gl.classification = 'admin_correction'
            AND gl.category = 'system_balance_correction'
            AND gl.direction = ANY (ARRAY['debit','cash_out']))
        OR (gl.classification = 'admin_correction'
            AND gl.category = 'system_balance_correction'
            AND gl.direction = ANY (ARRAY['credit','cash_in'])
            AND gl.source_table = 'fin_s14b1r_lines'
            AND gl.idempotency_key LIKE 'batch1\_restore:s14b1:%'
            AND EXISTS (SELECT 1 FROM public.fin_s14b1r_lines l
                        WHERE 'batch1_restore:' || l.orig_idempotency_key = gl.idempotency_key
                          AND l.ledger_scope = 'wallet'
                          AND l.user_id = gl.user_id
                          AND l.amount = gl.amount))
        OR (gl.classification = 'admin_correction'
            AND gl.category = 'merchant_float_correction_writedown'
            AND gl.direction = ANY (ARRAY['debit','cash_out']))
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      AND NOT (
        gl.source_table = 'commission_engine'
        AND EXISTS (
          SELECT 1 FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = p_user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
            AND cal.source_id = gl.source_id::text
        )
      )
      AND NOT (
        gl.source_table = 'commission_engine_reversal'
        AND gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.amount = 10000::numeric
        AND EXISTS (
          SELECT 1 FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = p_user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
        )
      )
  ), routed AS (
    SELECT l.amount, l.wallet_bucket AS bucket,
           CASE WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
                WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
                ELSE 0 END AS sign,
           l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
    UNION ALL
    SELECT l.amount, r.bucket, r.sign,
           l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(p_user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ), buckets AS (
    SELECT
      COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0) AS withdrawable_raw,
      COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0) AS float_raw,
      COALESCE(SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END), 0) AS advance_raw,
      COALESCE(SUM(CASE
        WHEN bucket = 'withdrawable'
         AND direction = ANY (ARRAY['cash_in','credit'])
         AND (maturity_expired = true OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now())))
        THEN amount ELSE 0 END), 0) AS restricted_held
    FROM routed
  ), holds AS (
    SELECT COALESCE(SUM(wr.amount), 0) AS pending_holds
    FROM public.withdrawal_requests wr
    WHERE (CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id ELSE wr.user_id END) = p_user_id
      AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction = ANY (ARRAY['cash_out','debit'])
      )
  )
  SELECT
    p_user_id,
    GREATEST(0::numeric, b.withdrawable_raw - b.restricted_held - h.pending_holds),
    GREATEST(0::numeric, b.float_raw),
    GREATEST(0::numeric, b.advance_raw),
    h.pending_holds,
    b.restricted_held,
    GREATEST(0::numeric, b.withdrawable_raw - b.restricted_held - h.pending_holds) + GREATEST(0::numeric, b.float_raw),
    b.float_raw
  FROM buckets b CROSS JOIN holds h;
$function$

;
CREATE OR REPLACE FUNCTION public.user_wallet_strict(p_user_id uuid)
 RETURNS TABLE(withdrawable numeric, float_balance numeric, advance_balance numeric, pending_holds numeric, total_visible numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH anchor AS (
  SELECT anchor_at FROM public.wallet_fresh_start_anchors WHERE user_id = p_user_id LIMIT 1
),
ledger AS (
  SELECT gl.category, gl.direction, gl.amount, gl.wallet_bucket
  FROM public.general_ledger gl
  WHERE gl.user_id = p_user_id
    AND gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL
         OR gl.classification = 'production'
         OR (gl.classification = 'admin_correction'
             AND gl.category = 'system_balance_correction'
             AND gl.direction = ANY (ARRAY['debit','cash_out']))
         OR (gl.classification = 'admin_correction'
            AND gl.category = 'system_balance_correction'
            AND gl.direction = ANY (ARRAY['credit','cash_in'])
            AND gl.source_table = 'fin_s14b1r_lines'
            AND gl.idempotency_key LIKE 'batch1\_restore:s14b1:%'
            AND EXISTS (SELECT 1 FROM public.fin_s14b1r_lines l
                        WHERE 'batch1_restore:' || l.orig_idempotency_key = gl.idempotency_key
                          AND l.ledger_scope = 'wallet'
                          AND l.user_id = gl.user_id
                          AND l.amount = gl.amount)))
    AND (gl.created_at >= COALESCE((SELECT anchor_at FROM anchor), gl.created_at))
),
routed_explicit AS (
  SELECT l.amount,
         l.wallet_bucket AS bucket,
         CASE WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
              WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
              ELSE 0 END AS sign
  FROM ledger l
  WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
),
routed_category AS (
  SELECT l.amount, r.bucket, r.sign
  FROM ledger l
  CROSS JOIN LATERAL public.wallet_route_for_category(p_user_id, l.category, l.direction) r(bucket, sign)
  WHERE l.wallet_bucket IS NULL
),
routed AS (
  SELECT amount, bucket, sign FROM routed_explicit
  UNION ALL
  SELECT amount, bucket, sign FROM routed_category
),
buckets AS (
  SELECT
    SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END) AS withdrawable_raw,
    SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END) AS float_raw,
    SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END) AS advance_raw
  FROM routed
),
holds AS (
  SELECT COALESCE(SUM(wr.amount), 0) AS pending_holds
  FROM public.withdrawal_requests wr
  WHERE (CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id ELSE wr.user_id END) = p_user_id
    AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction = ANY (ARRAY['cash_out','debit']))
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
)
SELECT
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw,0)) AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw,0)) AS advance_balance,
  COALESCE(h.pending_holds,0) AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) + GREATEST(0, COALESCE(b.float_raw,0)) AS total_visible
FROM buckets b CROSS JOIN holds h;
$function$

;
CREATE OR REPLACE VIEW public.v_user_wallet_strict AS  WITH anchors AS (
         SELECT wallet_fresh_start_anchors.user_id,
            wallet_fresh_start_anchors.anchor_at
           FROM wallet_fresh_start_anchors
        ), ledger AS (
         SELECT gl.user_id,
            gl.category,
            gl.direction,
            gl.amount,
            gl.wallet_bucket,
            gl.maturity_met,
            gl.maturity_expired,
            gl.withdrawable_after
           FROM general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
          WHERE gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text])) OR (gl.classification = 'admin_correction'
            AND gl.category = 'system_balance_correction'
            AND gl.direction = ANY (ARRAY['credit','cash_in'])
            AND gl.source_table = 'fin_s14b1r_lines'
            AND gl.idempotency_key LIKE 'batch1\_restore:s14b1:%'
            AND EXISTS (SELECT 1 FROM public.fin_s14b1r_lines l
                        WHERE 'batch1_restore:' || l.orig_idempotency_key = gl.idempotency_key
                          AND l.ledger_scope = 'wallet'
                          AND l.user_id = gl.user_id
                          AND l.amount = gl.amount)) OR gl.classification = 'admin_correction'::text AND gl.category = 'merchant_float_correction_writedown'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text]))) AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at) AND NOT (gl.source_table = 'commission_engine'::text AND (EXISTS ( SELECT 1
                   FROM commission_accrual_ledger cal
                  WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text AND cal.source_id = gl.source_id::text))) AND NOT (gl.source_table = 'commission_engine_reversal'::text AND gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND gl.amount = 10000::numeric AND (EXISTS ( SELECT 1
                   FROM commission_accrual_ledger cal
                  WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text)))
        ), routed_explicit AS (
         SELECT ledger.user_id,
            ledger.amount,
            ledger.wallet_bucket AS bucket,
                CASE
                    WHEN ledger.direction = ANY (ARRAY['cash_in'::text, 'credit'::text]) THEN 1
                    WHEN ledger.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]) THEN '-1'::integer
                    ELSE 0
                END AS sign,
            ledger.maturity_met,
            ledger.maturity_expired,
            ledger.withdrawable_after,
            ledger.direction,
            ledger.category
           FROM ledger
          WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable'::text, 'float'::text, 'advance_credit'::text, 'advance_repayment'::text])
        ), routed_category AS (
         SELECT l.user_id,
            l.amount,
            r.bucket,
            r.sign,
            l.maturity_met,
            l.maturity_expired,
            l.withdrawable_after,
            l.direction,
            l.category
           FROM ledger l
             CROSS JOIN LATERAL wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
          WHERE l.wallet_bucket IS NULL
        ), routed AS (
         SELECT routed_explicit.user_id,
            routed_explicit.amount,
            routed_explicit.bucket,
            routed_explicit.sign,
            routed_explicit.maturity_met,
            routed_explicit.maturity_expired,
            routed_explicit.withdrawable_after,
            routed_explicit.direction,
            routed_explicit.category
           FROM routed_explicit
        UNION ALL
         SELECT routed_category.user_id,
            routed_category.amount,
            routed_category.bucket,
            routed_category.sign,
            routed_category.maturity_met,
            routed_category.maturity_expired,
            routed_category.withdrawable_after,
            routed_category.direction,
            routed_category.category
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
                END) AS advance_raw,
            sum(
                CASE
                    WHEN routed.bucket = 'withdrawable'::text AND (routed.direction = ANY (ARRAY['cash_in'::text, 'credit'::text])) AND (routed.maturity_expired = true OR routed.maturity_met = false AND now() <= COALESCE(routed.withdrawable_after, now())) THEN routed.amount
                    ELSE 0::numeric
                END) AS restricted_held
           FROM routed
          GROUP BY routed.user_id
        ), holds AS (
         SELECT
                CASE
                    WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                    ELSE wr.user_id
                END AS user_id,
            COALESCE(sum(wr.amount), 0::numeric) AS pending_holds
           FROM withdrawal_requests wr
          WHERE (wr.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text, 'approved'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM general_ledger g
                  WHERE g.source_table = 'withdrawal_requests'::text AND g.source_id = wr.id AND g.ledger_scope = 'wallet'::text AND (g.direction = ANY (ARRAY['cash_out'::text, 'debit'::text])))) AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%'::text)
          GROUP BY (
                CASE
                    WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                    ELSE wr.user_id
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
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
    GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
    GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
    COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
    COALESCE(b.restricted_held, 0::numeric) AS restricted_held,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible,
    COALESCE(b.float_raw, 0::numeric) AS float_balance_signed
   FROM universe u
     LEFT JOIN buckets b ON b.user_id = u.user_id
     LEFT JOIN holds h ON h.user_id = u.user_id;