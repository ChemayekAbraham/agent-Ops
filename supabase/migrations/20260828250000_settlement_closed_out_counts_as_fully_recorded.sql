-- 20260828240000 taught the grading that a merchant_settlement_closed_out
-- row proves the payout happened (fixes pct_customer_debited to 100%). It
-- left pct_fully_recorded alone, which still requires a float-consumption
-- leg (merchant_payout_funding) and a commission award for every paid row.
-- But the closure's own recorded decision is that neither will ever be
-- posted for these rows -- "no retro float debit, telecom charge, out-of-
-- pocket receivable or commission is posted because the payout is already
-- paid and the merchant is actively trading. Excluded from merchant float
-- and out-of-pocket calculations." That is a final, deliberate close-out,
-- not an open gap -- so it should count as fully recorded, not partially.
-- Without this, Bayo Mercy/Hilary Evanz/Mudumba samuel sit at recording_gap
-- forever even though pct_customer_debited is already 100%.

CREATE OR REPLACE FUNCTION public.merchant_payout_success_matrix(p_days integer DEFAULT 30)
 RETURNS TABLE(merchant_id uuid, merchant_name text, attempts bigint, actioned bigint, paid bigint, pct_paid numeric, pct_customer_debited numeric, pct_fully_recorded numeric, stranded_processing bigint, grade text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT wr.id,
           COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) AS actor,
           wr.status,
           wr.reason,
           wr.fin_ops_reference
    FROM withdrawal_requests wr
    WHERE wr.created_at > now() - make_interval(days => GREATEST(p_days, 1))
      AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
          IN (SELECT ca.agent_id FROM cashout_agents ca)
  ), m AS (
    SELECT w.*,
      EXISTS (
        SELECT 1 FROM audit_logs a
        WHERE a.record_id = w.id::text AND a.action_type = 'merchant_settlement_closed_out'
      ) AS closed_out,
      (
        EXISTS (
          SELECT 1 FROM general_ledger g
          WHERE g.source_id = w.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
            AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')
        )
        OR (
          w.reason LIKE 'Landlord float payout%'
          AND EXISTS (
            SELECT 1 FROM general_ledger g
            WHERE g.source_id = w.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
              AND g.category = 'agent_float_settlement'
              AND COALESCE(g.reference_id, '') NOT LIKE '%-merchant-telecom-charge'
          )
        )
        OR (
          w.fin_ops_reference LIKE 'MANUAL-RECON-%'
        )
        OR (
          EXISTS (
            SELECT 1 FROM merchant_out_of_pocket_advances o
            WHERE o.withdrawal_id = w.id AND o.kind = 'payout'
          )
        )
        OR EXISTS (
          SELECT 1 FROM audit_logs a
          WHERE a.record_id = w.id::text AND a.action_type = 'merchant_settlement_closed_out'
        )
      ) AS debit,
      EXISTS (SELECT 1 FROM merchant_payout_funding f WHERE f.withdrawal_id = w.id) AS fund,
      EXISTS (SELECT 1 FROM merchant_commission_awards c WHERE c.withdrawal_id = w.id) AS comm
    FROM w
  ), agg AS (
    SELECT m.actor AS merchant_id,
      COUNT(*) AS attempts,
      COUNT(*) FILTER (WHERE m.status <> 'pending') AS actioned,
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed')) AS paid,
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed') AND m.debit) AS debited,
      COUNT(*) FILTER (
        WHERE m.status IN ('paid','completed')
          AND m.debit
          AND (m.closed_out OR (m.fund AND m.comm))
      ) AS full_rec,
      COUNT(*) FILTER (WHERE m.status = 'processing') AS stranded
    FROM m GROUP BY m.actor
  )
  SELECT a.merchant_id,
    COALESCE(p.full_name, 'unknown'),
    a.attempts, a.actioned, a.paid,
    ROUND(100.0 * a.paid / GREATEST(a.actioned, 1), 1),
    ROUND(100.0 * a.debited / GREATEST(a.paid, 1), 1),
    ROUND(100.0 * a.full_rec / GREATEST(a.paid, 1), 1),
    a.stranded,
    CASE
      WHEN a.paid = 0 THEN 'no_payouts'
      WHEN a.debited = a.paid AND a.full_rec = a.paid AND a.stranded = 0 THEN 'healthy'
      WHEN a.paid > 0 AND (a.paid - a.debited)::numeric / a.paid > 0.03 THEN 'money_risk'
      WHEN a.stranded > 0 THEN 'stranded_claims'
      ELSE 'recording_gap'
    END
  FROM agg a
  LEFT JOIN profiles p ON p.id = a.merchant_id
  ORDER BY a.attempts DESC;
$function$;
