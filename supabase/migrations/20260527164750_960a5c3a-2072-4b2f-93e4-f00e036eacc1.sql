CREATE TABLE public.bulk_bank_payout_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid NOT NULL REFERENCES public.gmail_transactions(id) ON DELETE CASCADE,
  withdrawal_request_id uuid NOT NULL UNIQUE REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL,
  proxy_agent_id uuid NOT NULL,
  allocated_amount numeric NOT NULL CHECK (allocated_amount > 0),
  status text NOT NULL DEFAULT 'settled',
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bulk_bank_payout_alloc_gmail ON public.bulk_bank_payout_allocations(gmail_transaction_id);
CREATE INDEX idx_bulk_bank_payout_alloc_partner ON public.bulk_bank_payout_allocations(partner_id);
CREATE INDEX idx_bulk_bank_payout_alloc_proxy ON public.bulk_bank_payout_allocations(proxy_agent_id);

GRANT SELECT, INSERT, UPDATE ON public.bulk_bank_payout_allocations TO authenticated;
GRANT ALL ON public.bulk_bank_payout_allocations TO service_role;

ALTER TABLE public.bulk_bank_payout_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read bulk_bank_payout_allocations"
ON public.bulk_bank_payout_allocations
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
);

CREATE POLICY "Service role manages bulk_bank_payout_allocations"
ON public.bulk_bank_payout_allocations
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

ALTER TABLE public.gmail_transactions
  ADD COLUMN IF NOT EXISTS is_bulk_bank_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bulk_payout_allocated_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bulk_payout_settled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_gmail_tx_bulk_bank_payout
  ON public.gmail_transactions(internal_date DESC)
  WHERE is_bulk_bank_payout = true;

CREATE OR REPLACE FUNCTION public.detect_bulk_bank_payout_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_needle text := 'skybubbles trading and investment limited';
BEGIN
  IF (lower(coalesce(NEW.subject,'')) LIKE '%'||v_needle||'%')
     OR (lower(coalesce(NEW.snippet,'')) LIKE '%'||v_needle||'%')
     OR (lower(coalesce(NEW.raw_body,'')) LIKE '%'||v_needle||'%')
     OR (lower(coalesce(NEW.from_name,'')) LIKE '%'||v_needle||'%')
     OR (lower(coalesce(NEW.counterparty,'')) LIKE '%'||v_needle||'%')
  THEN
    NEW.is_bulk_bank_payout := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_detect_bulk_bank_payout ON public.gmail_transactions;
CREATE TRIGGER trg_detect_bulk_bank_payout
BEFORE INSERT ON public.gmail_transactions
FOR EACH ROW
EXECUTE FUNCTION public.detect_bulk_bank_payout_email();

CREATE OR REPLACE FUNCTION public.fire_auto_settle_bulk_bank_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_service_key text;
BEGIN
  IF NEW.is_bulk_bank_payout IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_service_key := NULL;
  END;

  v_url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/auto-settle-bulk-bank-payout';

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || coalesce(v_service_key, '')
      ),
      body := jsonb_build_object('gmail_transaction_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_settle_bulk_bank_payout ON public.gmail_transactions;
CREATE TRIGGER trg_auto_settle_bulk_bank_payout
AFTER INSERT ON public.gmail_transactions
FOR EACH ROW
WHEN (NEW.is_bulk_bank_payout = true)
EXECUTE FUNCTION public.fire_auto_settle_bulk_bank_payout();

UPDATE public.gmail_transactions
SET is_bulk_bank_payout = true
WHERE is_bulk_bank_payout = false
  AND (
    lower(coalesce(subject,''))       LIKE '%skybubbles trading and investment limited%'
 OR lower(coalesce(snippet,''))       LIKE '%skybubbles trading and investment limited%'
 OR lower(coalesce(raw_body,''))      LIKE '%skybubbles trading and investment limited%'
 OR lower(coalesce(from_name,''))     LIKE '%skybubbles trading and investment limited%'
 OR lower(coalesce(counterparty,''))  LIKE '%skybubbles trading and investment limited%'
  );