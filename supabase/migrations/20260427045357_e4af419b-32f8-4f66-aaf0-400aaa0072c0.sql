-- Glossary terms managed by Ops/Admin
CREATE TABLE public.glossary_terms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  term TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Money',
  short TEXT NOT NULL,
  example TEXT,
  also TEXT[] NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX glossary_terms_term_key
  ON public.glossary_terms (lower(term));

CREATE INDEX glossary_terms_category_idx
  ON public.glossary_terms (category, sort_order);

ALTER TABLE public.glossary_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active glossary terms"
ON public.glossary_terms
FOR SELECT
TO authenticated
USING (is_active = true);

CREATE POLICY "Admins can read all glossary terms"
ON public.glossary_terms
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Admins can insert glossary terms"
ON public.glossary_terms
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Admins can update glossary terms"
ON public.glossary_terms
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Admins can delete glossary terms"
ON public.glossary_terms
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

CREATE TRIGGER update_glossary_terms_updated_at
BEFORE UPDATE ON public.glossary_terms
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.glossary_terms (term, category, short, example, also, sort_order) VALUES
('Float', 'Money', 'An agent''s permission to collect cash. Like airtime on a SIM — once it''s used up, they can''t collect more until it''s refilled.', 'Agent has UGX 5,000,000 float → they can collect up to that much before depositing.', ARRAY['Float Limit','Refill','Cash on Hand'], 10),
('Float Limit', 'Money', 'The maximum amount of cash an agent is trusted to hold at one time. Set by Agent Ops.', NULL, ARRAY[]::TEXT[], 11),
('Cash on Hand', 'Money', 'The physical cash an agent is currently holding from collections that has not yet been deposited back to Welile.', NULL, ARRAY[]::TEXT[], 12),
('Cash Collected', 'Money', 'Money the agent has physically received from a tenant. The moment this is recorded, the float drops by the same amount.', 'Tenant pays UGX 200,000 → float drops by 200,000, cash on hand goes up by 200,000.', ARRAY[]::TEXT[], 13),
('Deposit / Refill', 'Money', 'When the agent returns cash to Welile (via merchant code, bank, or branch). Once Finance confirms it, their float is topped back up.', NULL, ARRAY['Float'], 14),
('Withdrawable Balance', 'Money', 'Money in a wallet the user can actually take out — earned commissions, refunds, or returned investments.', NULL, ARRAY[]::TEXT[], 15),
('Advance Balance', 'Money', 'Money lent to an agent against future earnings. Repaid automatically as commissions come in.', NULL, ARRAY[]::TEXT[], 16),
('Wallet (3 Buckets)', 'Money', 'Every wallet has three pockets: Withdrawable (cash out), Float (collect on behalf of Welile), and Advance (loaned). They never mix.', NULL, ARRAY[]::TEXT[], 17),
('Commission', 'Money', 'The percentage an agent earns on a successful collection or investment. Lands in the Withdrawable bucket.', NULL, ARRAY[]::TEXT[], 18),
('Payout / Disbursement', 'Money', 'Money moving OUT of Welile to a landlord or partner — usually via Mobile Money or via an agent delivering cash in person.', NULL, ARRAY[]::TEXT[], 19),
('Rent Request', 'Process', 'A tenant''s application to have Welile pay their landlord upfront so the tenant can repay in installments.', NULL, ARRAY[]::TEXT[], 20),
('Rent Plan', 'Process', 'The repayment schedule for a funded rent request — daily/weekly/monthly installments back to Welile.', NULL, ARRAY[]::TEXT[], 21),
('Proxy Payout', 'Process', 'When an agent physically delivers cash to a landlord on Welile''s behalf instead of a Mobile Money transfer.', NULL, ARRAY[]::TEXT[], 22),
('Reconciliation', 'Process', 'End-of-day check: does what the agent says they collected match what''s actually in their float and deposit slips?', NULL, ARRAY[]::TEXT[], 23),
('OTP Verification', 'Process', 'A one-time SMS code used to confirm a sensitive action (e.g., landlord confirming they received cash).', NULL, ARRAY[]::TEXT[], 24),
('Agent', 'Roles', 'A field representative who registers tenants/landlords, collects rent in cash, and delivers payouts.', NULL, ARRAY[]::TEXT[], 30),
('Sub-Agent', 'Roles', 'An agent recruited and managed by another agent. Earns their own commissions; the parent agent earns 1% override.', NULL, ARRAY[]::TEXT[], 31),
('Proxy Agent', 'Roles', 'An agent assigned to act on behalf of a partner (typically a non-smartphone user) for deposits and withdrawals.', NULL, ARRAY[]::TEXT[], 32),
('Supporter / Funder', 'Roles', 'A person who deposits money into Welile to fund tenant rent and earns monthly returns.', NULL, ARRAY[]::TEXT[], 33),
('Partner', 'Roles', 'A funder who works through an agent (often without their own smartphone). The agent manages their wallet on their behalf.', NULL, ARRAY[]::TEXT[], 34),
('Tenant', 'Tenant', 'The renter. Welile pays their rent upfront; they repay in installments.', NULL, ARRAY[]::TEXT[], 40),
('Tenant Wallet', 'Tenant', 'The tenant''s account inside Welile. Auto-deductions for rent installments come from here first.', NULL, ARRAY[]::TEXT[], 41),
('Auto-Deduction', 'Tenant', 'When rent is due, the system pulls from the tenant''s wallet first; if short, it falls back to the agent''s wallet; if both are short, it''s recorded as debt.', NULL, ARRAY[]::TEXT[], 42),
('Landlord', 'Landlord', 'The property owner who receives rent from Welile (Mobile Money or agent cash drop).', NULL, ARRAY[]::TEXT[], 50),
('House Listing', 'Landlord', 'A vacant property posted to Welile''s marketplace. Agents earn UGX 5,000 per verified listing.', NULL, ARRAY[]::TEXT[], 51),
('Tracking ID', 'Agent Ops', 'A unique receipt reference (e.g., WLE-2026-00123) generated for every payment, so tenant, agent and Finance can trace it.', NULL, ARRAY[]::TEXT[], 60),
('Pending Sync', 'Agent Ops', 'Payments recorded offline that haven''t reached the server yet. They upload automatically once the agent has signal.', NULL, ARRAY[]::TEXT[], 61),
('Streak', 'Agent Ops', 'Consecutive days an agent has collected at least one payment. Longer streaks earn badges and bonus multipliers.', NULL, ARRAY[]::TEXT[], 62),
('Trust Score', 'Agent Ops', 'Welile''s internal credit rating for a tenant or partner, based on payment history, supporters, and verified signals.', NULL, ARRAY[]::TEXT[], 63),
('Escalation', 'Agent Ops', 'A flagged issue from the field (missing tenant, refused payout, dispute) that needs Agent Ops to resolve.', NULL, ARRAY[]::TEXT[], 64);
