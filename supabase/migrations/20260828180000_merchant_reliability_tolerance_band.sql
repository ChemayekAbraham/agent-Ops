-- `money_risk` used to fire on ANY unexplained payout (debited < paid), so a
-- single gap out of hundreds zeroed a desk's entire earned capacity in
-- performanceFactor() (src/lib/merchantFloatCapacity.ts) exactly as hard as
-- a desk with a real, persistent problem. Post the landlord-float evidence
-- fix (20260828170000), several busy desks still sit at 94-98% debited —
-- Mudumba samuel 97.1%, Nakajjubi Shamirah 97.4%, Babrah Tusingwire 98.4% —
-- and were still fully blocked for a residual gap smaller than 3% of volume.
--
-- Adds a small tolerance band: a gap of 3% or less of paid volume now grades
-- 'recording_gap' (worth fewer points than 'healthy', but NOT a blocker —
-- see the CASE in merchant_agent_float_allocation_report, blocker only fires
-- on money_risk/stranded_claims) instead of 'money_risk'. A gap ABOVE 3% —
-- Hilary Evanz at 94.5% (5.5% missing) — still grades money_risk and stays
-- blocked; this is not a blanket loosening, it's a floor under noise.
-- 3% is a judgment call, not derived from anything — revisit if it proves
-- too loose or too strict in practice.

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
           wr.reason
    FROM withdrawal_requests wr
    WHERE wr.created_at > now() - make_interval(days => GREATEST(p_days, 1))
      AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
          IN (SELECT ca.agent_id FROM cashout_agents ca)
  ), m AS (
    SELECT w.*,
      (
        EXISTS (
          SELECT 1 FROM general_ledger g
          WHERE g.source_id = w.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
            AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')
        )
        OR (
          -- Landlord-float payouts never post a wallet_withdrawal leg by
          -- design. Their proof of payment is the float-settlement principal
          -- leg instead.
          w.reason LIKE 'Landlord float payout%'
          AND EXISTS (
            SELECT 1 FROM general_ledger g
            WHERE g.source_id = w.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
              AND g.category = 'agent_float_settlement'
              AND COALESCE(g.reference_id, '') NOT LIKE '%-merchant-telecom-charge'
          )
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
      COUNT(*) FILTER (WHERE m.status IN ('paid','completed') AND m.debit AND m.fund AND m.comm) AS full_rec,
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
      -- More than 3% of paid volume unexplained -> real signal, stays blocked.
      WHEN a.paid > 0 AND (a.paid - a.debited)::numeric / a.paid > 0.03 THEN 'money_risk'
      WHEN a.stranded > 0 THEN 'stranded_claims'
      -- 3% or less unexplained (or debited=paid but full_rec/stranded not
      -- clean) -> small, tolerated gap. Not a blocker.
      ELSE 'recording_gap'
    END
  FROM agg a
  LEFT JOIN profiles p ON p.id = a.merchant_id
  ORDER BY a.attempts DESC;
$function$;
