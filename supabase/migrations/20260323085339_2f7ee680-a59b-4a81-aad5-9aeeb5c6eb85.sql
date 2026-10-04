
-- Expense category enum for financial agents
CREATE TYPE public.expense_category AS ENUM (
  'operations', 'marketing', 'research_and_development', 'salaries', 'agent_advances', 'employee_advances', 'general'
);

-- Financial Agents: tagged agents who receive platform expense disbursements
CREATE TABLE public.financial_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES public.profiles(id),
  expense_category expense_category NOT NULL DEFAULT 'general',
  label TEXT NOT NULL DEFAULT 'Financial Agent',
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, expense_category)
);

ALTER TABLE public.financial_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers and executives can manage financial agents"
  ON public.financial_agents FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Proxy Agent Assignments: agents acting on behalf of landlords/partners without smartphones
CREATE TABLE public.proxy_agent_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  beneficiary_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  beneficiary_role TEXT NOT NULL CHECK (beneficiary_role IN ('landlord', 'supporter')),
  assigned_by UUID NOT NULL REFERENCES public.profiles(id),
  reason TEXT DEFAULT 'No smartphone access',
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, beneficiary_id)
);

ALTER TABLE public.proxy_agent_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers and executives can manage proxy assignments"
  ON public.proxy_agent_assignments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Agents can view own proxy assignments"
  ON public.proxy_agent_assignments FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

-- Platform expense transfers ledger tracking
CREATE TABLE public.platform_expense_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_agent_id UUID NOT NULL REFERENCES public.financial_agents(id),
  agent_id UUID NOT NULL REFERENCES public.profiles(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  expense_category expense_category NOT NULL,
  description TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES public.profiles(id),
  ledger_reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_expense_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage expense transfers"
  ON public.platform_expense_transfers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Payroll batches for monthly salary processing
CREATE TABLE public.payroll_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'completed', 'failed')),
  total_amount NUMERIC NOT NULL DEFAULT 0,
  total_employees INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage payroll"
  ON public.payroll_batches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE TABLE public.payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.payroll_batches(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.profiles(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL DEFAULT 'salary' CHECK (category IN ('salary', 'advance', 'bonus', 'allowance')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  paid_at TIMESTAMPTZ,
  ledger_reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage payroll items"
  ON public.payroll_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
