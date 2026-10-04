
CREATE TABLE public.ledger_account_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code text UNIQUE NOT NULL,
  description text NOT NULL
);

ALTER TABLE public.ledger_account_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view account groups"
ON public.ledger_account_groups FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can manage account groups"
ON public.ledger_account_groups FOR ALL
USING (has_role(auth.uid(), 'manager'::app_role));
