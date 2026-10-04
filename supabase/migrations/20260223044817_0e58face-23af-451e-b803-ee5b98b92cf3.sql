
CREATE TABLE public.ledger_accounts (
  account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.ledger_account_groups(group_id),
  account_code text NOT NULL,
  owner_type text,
  owner_id uuid,
  currency text DEFAULT 'UGX',
  allow_negative boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account_code, owner_id)
);

ALTER TABLE public.ledger_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view all accounts"
ON public.ledger_accounts FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can manage accounts"
ON public.ledger_accounts FOR ALL
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Users can view own accounts"
ON public.ledger_accounts FOR SELECT
USING (auth.uid() = owner_id);
