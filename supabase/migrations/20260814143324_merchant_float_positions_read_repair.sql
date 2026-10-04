-- Fix: "Money With Merchant Agents" (get_merchant_float_positions, powers
-- MoneyWithAgentsCard on the Financial Ops overview) reads the agent's
-- float balance from the `wallets` view, which is a thin join onto
-- wallet_balances_projection with NO dirty-flag check:
--
--   CREATE OR REPLACE VIEW public.wallets AS
--   SELECT ... COALESCE(p.float_balance, 0) AS float_balance ...
--   FROM public.wallets_physical wp
--   LEFT JOIN public.wallet_balances_projection p ON p.user_id = wp.user_id;
--   (20260723195215_...sql)
--
-- Since the 2026-08-11 dirty-flag deferral (20260811050458_...sql), a
-- general_ledger write only marks that agent's projection row dirty; the
-- actual recompute is deferred to the next read-repair call or the 2-min
-- cron sweep. Every other admin-facing balance read (get_user_wallet_view,
-- get_user_available_balance, get_wallets_batch, the negative-balance
-- guard) was updated that same migration to read-repair dirty/missing rows
-- before trusting the number. get_merchant_float_positions was rewritten
-- two days later (20260813123714_...sql) for the merchant-float fix plan,
-- but it selects straight from the `wallets` view and was never given the
-- same read-repair step -- so "our cash still on their phones" on the
-- Financial Ops overview can lag up to a full sweep cycle (or longer, if a
-- sweep run is skipped/slow) behind an agent's actual float after a payout
-- or a fresh float top-up land. This mirrors get_wallets_batch's exact
-- dirty-or-missing check, just scoped to desk agents instead of an
-- arbitrary uuid[].

CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
RETURNS TABLE(
  desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text,
  is_active boolean, paid_out_total numeric, reimbursed_total numeric,
  float_credits_recorded numeric, email_matched_total numeric,
  adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric,
  ledger_float_held numeric, offledger_adjustments numeric,
  payouts_without_float_evidence numeric,
  last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone
)
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

  -- Read-repair every desk agent's wallet projection before this function
  -- trusts wallets.float_balance below, so "company cash with agent" can
  -- never surface a stale pre-write figure regardless of sweep timing.
  FOR v_agent_id IN
    SELECT DISTINCT ca.agent_id
    FROM public.cashout_agents ca
    WHERE ca.agent_id IS NOT NULL
      AND (v_is_finance OR ca.agent_id = auth.uid())
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
           p.full_name, p.phone,
           right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE v_is_finance OR ca.agent_id = auth.uid()
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(w.processed_at) AS last_at
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
     AND g.category = 'agent_float_deposit'
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
    LEFT JOIN public.merchant_float_reconciliations r ON r.desk_id = d.id
    GROUP BY d.id
  ),
  -- The ONLY pool the payout engine can reserve and consume.
  held AS (
    SELECT d.id AS desk_id, COALESCE(GREATEST(w.float_balance, 0), 0) AS ledger_float
    FROM desks d
    LEFT JOIN public.wallets w ON w.user_id = d.agent_id
  ),
  -- Completed payouts that carry no proven float consumption: the agent's own line.
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(GREATEST(f.own_cash_principal, 0)), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_payout_funding f
      ON f.agent_id = d.agent_id
     AND f.funding_source IN ('own_cash', 'mixed', 'needs_review')
    GROUP BY d.id
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total,
         fc.total + aj.total,
         fc.total,
         em.total,
         aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         -- Company cash in the agent's hands == ledger-backed float they hold.
         hd.ledger_float,
         hd.ledger_float,
         aj.total,
         ub.total,
         pd.last_at,
         GREATEST(fc.last_at, em.last_at)
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  ORDER BY hd.ledger_float DESC, GREATEST(pd.total - (fc.total + aj.total), 0) DESC;
END;
$function$;
