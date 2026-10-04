
-- Cashout agents: CFO-assigned agents who handle cash/bank payouts
CREATE TABLE public.cashout_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES public.profiles(id),
  is_active boolean NOT NULL DEFAULT true,
  handles_cash boolean NOT NULL DEFAULT true,
  handles_bank boolean NOT NULL DEFAULT true,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id)
);

ALTER TABLE public.cashout_agents ENABLE ROW LEVEL SECURITY;

-- Admins and the agent themselves can read
CREATE POLICY "Authenticated can read cashout_agents" ON public.cashout_agents
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage cashout_agents" ON public.cashout_agents
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('cfo', 'coo', 'manager', 'super_admin'))
  );

-- Payout codes: generated for cash withdrawals after approval
CREATE TABLE public.payout_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_request_id uuid NOT NULL REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  code text NOT NULL UNIQUE,
  qr_data text NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'paid', 'expired')),
  claimed_by uuid REFERENCES public.profiles(id),
  claimed_at timestamptz,
  paid_at timestamptz,
  paid_by uuid REFERENCES public.profiles(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payout_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read payout_codes" ON public.payout_codes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service can insert payout_codes" ON public.payout_codes
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Agents can update payout_codes" ON public.payout_codes
  FOR UPDATE TO authenticated USING (true);

-- Add payout_code to withdrawal_requests
ALTER TABLE public.withdrawal_requests ADD COLUMN IF NOT EXISTS payout_code text;
ALTER TABLE public.withdrawal_requests ADD COLUMN IF NOT EXISTS assigned_cashout_agent_id uuid REFERENCES public.cashout_agents(id);
