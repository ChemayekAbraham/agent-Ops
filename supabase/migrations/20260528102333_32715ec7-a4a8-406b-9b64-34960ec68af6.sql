CREATE TABLE IF NOT EXISTS public.bulk_payout_sender_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  needle text NOT NULL UNIQUE,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

GRANT SELECT ON public.bulk_payout_sender_patterns TO authenticated;
GRANT ALL ON public.bulk_payout_sender_patterns TO service_role;

ALTER TABLE public.bulk_payout_sender_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read bulk payout patterns"
ON public.bulk_payout_sender_patterns FOR SELECT TO authenticated
USING (
  has_role(auth.uid(),'manager'::app_role)
  OR has_role(auth.uid(),'super_admin'::app_role)
  OR has_role(auth.uid(),'cfo'::app_role)
  OR has_role(auth.uid(),'coo'::app_role)
  OR has_role(auth.uid(),'operations'::app_role)
);

CREATE POLICY "Service role manages bulk payout patterns"
ON public.bulk_payout_sender_patterns FOR ALL TO service_role
USING (true) WITH CHECK (true);

INSERT INTO public.bulk_payout_sender_patterns (needle, label) VALUES
  ('skybubbles trading and investment limited', 'SKYBUBBLES (Equity Bank bulk payout)')
ON CONFLICT (needle) DO NOTHING;

ALTER TABLE public.bulk_bank_payout_allocations
  ADD COLUMN IF NOT EXISTS remaining_after numeric;

CREATE OR REPLACE FUNCTION public.detect_bulk_bank_payout_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hay text;
BEGIN
  v_hay := lower(
    coalesce(NEW.subject,'') || ' ' ||
    coalesce(NEW.snippet,'') || ' ' ||
    coalesce(NEW.raw_body,'') || ' ' ||
    coalesce(NEW.from_name,'') || ' ' ||
    coalesce(NEW.from_email,'') || ' ' ||
    coalesce(NEW.counterparty,'')
  );

  IF EXISTS (
    SELECT 1 FROM public.bulk_payout_sender_patterns p
    WHERE p.active = true AND v_hay LIKE '%' || lower(p.needle) || '%'
  ) THEN
    NEW.is_bulk_bank_payout := true;
  END IF;

  RETURN NEW;
END;
$$;

UPDATE public.gmail_transactions g
SET is_bulk_bank_payout = true
WHERE is_bulk_bank_payout = false
  AND EXISTS (
    SELECT 1 FROM public.bulk_payout_sender_patterns p
    WHERE p.active = true
      AND lower(
        coalesce(g.subject,'') || ' ' ||
        coalesce(g.snippet,'') || ' ' ||
        coalesce(g.raw_body,'') || ' ' ||
        coalesce(g.from_name,'') || ' ' ||
        coalesce(g.from_email,'') || ' ' ||
        coalesce(g.counterparty,'')
      ) LIKE '%' || lower(p.needle) || '%'
  );