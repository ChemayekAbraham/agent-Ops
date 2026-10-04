CREATE TABLE IF NOT EXISTS public.email_match_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid,
  deposit_request_id uuid,
  action text NOT NULL CHECK (action IN ('auto_claim','unclaim','manual_link','approve','bulk_approve','skip')),
  matcher_type text,
  match_score integer,
  signals jsonb,
  amount numeric,
  actor_id uuid,
  actor_email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_match_audit_created ON public.email_match_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_match_audit_gmail ON public.email_match_audit_log (gmail_transaction_id);
CREATE INDEX IF NOT EXISTS idx_email_match_audit_deposit ON public.email_match_audit_log (deposit_request_id);
CREATE INDEX IF NOT EXISTS idx_email_match_audit_action ON public.email_match_audit_log (action);

ALTER TABLE public.email_match_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can view email match audit" ON public.email_match_audit_log;
CREATE POLICY "Ops can view email match audit"
ON public.email_match_audit_log FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);

DROP POLICY IF EXISTS "Authenticated can write email match audit" ON public.email_match_audit_log;
CREATE POLICY "Authenticated can write email match audit"
ON public.email_match_audit_log FOR INSERT TO authenticated
WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.log_gmail_match_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE') AND (NEW.linked_deposit_request_id IS DISTINCT FROM OLD.linked_deposit_request_id) THEN
    IF NEW.linked_deposit_request_id IS NOT NULL THEN
      INSERT INTO public.email_match_audit_log (
        gmail_transaction_id, deposit_request_id, action, matcher_type, amount, actor_id, notes
      ) VALUES (
        NEW.id, NEW.linked_deposit_request_id,
        CASE WHEN auth.uid() IS NULL THEN 'auto_claim' ELSE 'manual_link' END,
        NEW.auto_match_method, NEW.amount, auth.uid(),
        CASE WHEN auth.uid() IS NULL THEN 'Auto-matcher claimed row' ELSE 'Operator linked from Needs Review' END
      );
    ELSE
      INSERT INTO public.email_match_audit_log (
        gmail_transaction_id, deposit_request_id, action, amount, actor_id, notes
      ) VALUES (
        NEW.id, OLD.linked_deposit_request_id, 'unclaim', NEW.amount, auth.uid(),
        'Email unlinked from deposit'
      );
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_log_gmail_match_change ON public.gmail_transactions;
CREATE TRIGGER trg_log_gmail_match_change
AFTER UPDATE ON public.gmail_transactions
FOR EACH ROW EXECUTE FUNCTION public.log_gmail_match_change();