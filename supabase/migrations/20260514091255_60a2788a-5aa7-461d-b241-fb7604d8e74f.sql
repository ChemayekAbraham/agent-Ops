
-- 1. Settlement table
CREATE TABLE IF NOT EXISTS public.proxy_payout_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL UNIQUE,
  withdrawal_id uuid NULL,
  partner_id uuid NOT NULL,
  agent_id uuid NULL,
  amount_settled numeric NOT NULL DEFAULT 0,
  settled_at timestamptz NOT NULL DEFAULT now(),
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pps_partner ON public.proxy_payout_settlements(partner_id);
CREATE INDEX IF NOT EXISTS idx_pps_agent ON public.proxy_payout_settlements(agent_id);
CREATE INDEX IF NOT EXISTS idx_pps_withdrawal ON public.proxy_payout_settlements(withdrawal_id);

ALTER TABLE public.proxy_payout_settlements ENABLE ROW LEVEL SECURITY;

-- Agents: see settlements they performed
CREATE POLICY "agents_view_own_proxy_settlements"
ON public.proxy_payout_settlements
FOR SELECT
USING (agent_id = auth.uid());

-- Partners: see settlements against their funds
CREATE POLICY "partners_view_own_proxy_settlements"
ON public.proxy_payout_settlements
FOR SELECT
USING (partner_id = auth.uid());

-- Manager / CFO oversight
CREATE POLICY "staff_view_all_proxy_settlements"
ON public.proxy_payout_settlements
FOR SELECT
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
);

-- 2. Backfill: close every CFO-approved ROI approval whose partner's strict
--    withdrawable balance is already <= 50 UGX (i.e. already paid out).
INSERT INTO public.proxy_payout_settlements
  (approval_id, withdrawal_id, partner_id, agent_id, amount_settled, notes)
SELECT
  pwo.id,
  NULL,
  ip.investor_id,
  pwo.target_wallet_user_id,
  pwo.amount,
  'backfill: partner strict withdrawable <= 50 UGX at 2026-05-14'
FROM public.pending_wallet_operations pwo
JOIN public.investor_portfolios ip ON ip.id = pwo.source_id
LEFT JOIN public.v_user_wallet_strict s ON s.user_id = ip.investor_id
WHERE pwo.category = 'roi_payout'
  AND pwo.status = 'approved'
  AND pwo.metadata ? 'coo_approved_by'
  AND COALESCE(s.withdrawable, 0) <= 50
ON CONFLICT (approval_id) DO NOTHING;
