
-- Agent Advances: main table
CREATE TABLE public.agent_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  principal numeric NOT NULL DEFAULT 0,
  outstanding_balance numeric NOT NULL DEFAULT 0,
  daily_rate numeric NOT NULL DEFAULT 0.33,
  cycle_days integer NOT NULL DEFAULT 30,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'overdue')),
  issued_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Agent Advance Ledger: daily interest/deduction log
CREATE TABLE public.agent_advance_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id) ON DELETE CASCADE,
  date date NOT NULL,
  opening_balance numeric NOT NULL DEFAULT 0,
  interest_accrued numeric NOT NULL DEFAULT 0,
  amount_deducted numeric NOT NULL DEFAULT 0,
  closing_balance numeric NOT NULL DEFAULT 0,
  deduction_status text NOT NULL DEFAULT 'none' CHECK (deduction_status IN ('full', 'partial', 'none')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Agent Advance Top-ups
CREATE TABLE public.agent_advance_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  topped_up_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_agent_advances_agent_id ON public.agent_advances(agent_id);
CREATE INDEX idx_agent_advances_status ON public.agent_advances(status);
CREATE INDEX idx_agent_advance_ledger_advance_id ON public.agent_advance_ledger(advance_id);
CREATE INDEX idx_agent_advance_ledger_date ON public.agent_advance_ledger(date);
CREATE INDEX idx_agent_advance_topups_advance_id ON public.agent_advance_topups(advance_id);

-- Enable RLS
ALTER TABLE public.agent_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_advance_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_advance_topups ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Manager-only access
CREATE POLICY "Managers can view all advances"
  ON public.agent_advances FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert advances"
  ON public.agent_advances FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update advances"
  ON public.agent_advances FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

-- Agents can view their own advances
CREATE POLICY "Agents can view own advances"
  ON public.agent_advances FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

-- Ledger policies
CREATE POLICY "Managers can view all ledger entries"
  ON public.agent_advance_ledger FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert ledger entries"
  ON public.agent_advance_ledger FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Top-up policies
CREATE POLICY "Managers can view all topups"
  ON public.agent_advance_topups FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert topups"
  ON public.agent_advance_topups FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Updated_at trigger for agent_advances
CREATE TRIGGER update_agent_advances_updated_at
  BEFORE UPDATE ON public.agent_advances
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
