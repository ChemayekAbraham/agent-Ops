-- Dedicated audit log for every wallet DEBIT performed from the Financial Ops
-- "Recent Emails" routing tool. Captures who performed the debit, which wallet
-- (including the selected proxy agent), the amount, and all linked transaction
-- references in one immutable record.
CREATE TABLE public.proxy_debit_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- WHO performed the debit
  performed_by uuid NOT NULL,
  performed_by_name text,
  -- WHICH wallet was actually charged (the proxy agent when proxy route used)
  debited_user_id uuid NOT NULL,
  debited_user_name text,
  debited_user_phone text,
  -- Routing details
  debit_route text NOT NULL, -- withdrawable | landlord_float | proxy_agent_wallet
  is_proxy_debit boolean NOT NULL DEFAULT false,
  proxy_manual_pick boolean NOT NULL DEFAULT false, -- operator chose ANY agent
  proxy_managed boolean NOT NULL DEFAULT false,      -- managed-proxy auto-redirect
  -- The partner the outgoing email was matched to (when a proxy was charged)
  partner_user_id uuid,
  partner_user_name text,
  -- Money
  amount numeric NOT NULL,
  -- Linked transaction references
  transaction_id text,            -- parsed TID / MoMo / bank reference
  gmail_transaction_id uuid,
  gmail_message_id text,
  ledger_reference_id text,
  transaction_references jsonb NOT NULL DEFAULT '{}'::jsonb, -- full reference bag
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.proxy_debit_audit_log TO authenticated;
GRANT ALL ON public.proxy_debit_audit_log TO service_role;

ALTER TABLE public.proxy_debit_audit_log ENABLE ROW LEVEL SECURITY;

-- Only financial governance roles may write, and the row must be stamped with
-- the acting operator's own id (no impersonation).
CREATE POLICY "Financial governance can insert debit audit log"
ON public.proxy_debit_audit_log
FOR INSERT
TO authenticated
WITH CHECK (
  performed_by = auth.uid()
  AND (
    has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  )
);

-- Read access for financial governance roles.
CREATE POLICY "Financial governance can view debit audit log"
ON public.proxy_debit_audit_log
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE INDEX idx_proxy_debit_audit_created_at ON public.proxy_debit_audit_log (created_at DESC);
CREATE INDEX idx_proxy_debit_audit_debited_user ON public.proxy_debit_audit_log (debited_user_id, created_at DESC);
CREATE INDEX idx_proxy_debit_audit_performed_by ON public.proxy_debit_audit_log (performed_by, created_at DESC);
CREATE INDEX idx_proxy_debit_audit_gmail_tx ON public.proxy_debit_audit_log (gmail_transaction_id);