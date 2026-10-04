CREATE TABLE IF NOT EXISTS public.gmail_dedup_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id text NOT NULL,
  dedup_hash text,
  matched_transaction_id text,
  matched_row_id uuid,
  reason text NOT NULL,
  from_email text,
  subject text,
  snippet text,
  internal_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_dedup_audit_created
  ON public.gmail_dedup_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_dedup_audit_hash
  ON public.gmail_dedup_audit (dedup_hash);

ALTER TABLE public.gmail_dedup_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff can read gmail_dedup_audit"
  ON public.gmail_dedup_audit FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.gmail_dedup_audit;