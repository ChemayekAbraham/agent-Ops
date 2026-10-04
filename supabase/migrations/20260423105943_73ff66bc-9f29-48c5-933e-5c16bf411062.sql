-- Migration 2 of 3: Make silent overdraw clamps observable
CREATE TABLE IF NOT EXISTS public.wallet_overdraw_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  attempted_balance   numeric NOT NULL,
  clamped_to          numeric NOT NULL DEFAULT 0,
  delta_lost          numeric GENERATED ALWAYS AS (clamped_to - attempted_balance) STORED,
  withdrawable_before numeric,
  withdrawable_after  numeric,
  float_before        numeric,
  float_after         numeric,
  advance_before      numeric,
  advance_after       numeric,
  trigger_op          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_overdraw_events_user
  ON public.wallet_overdraw_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_overdraw_events_created
  ON public.wallet_overdraw_events (created_at DESC);

ALTER TABLE public.wallet_overdraw_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can read wallet overdraw events"
  ON public.wallet_overdraw_events;

CREATE POLICY "Staff can read wallet overdraw events"
ON public.wallet_overdraw_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);

CREATE OR REPLACE FUNCTION public.enforce_non_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_attempted numeric;
BEGIN
  IF NEW.balance < 0 THEN
    v_attempted := NEW.balance;
    NEW.balance := 0;

    BEGIN
      INSERT INTO public.wallet_overdraw_events (
        user_id, attempted_balance, clamped_to,
        withdrawable_before, withdrawable_after,
        float_before, float_after,
        advance_before, advance_after,
        trigger_op
      ) VALUES (
        NEW.user_id, v_attempted, 0,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.withdrawable_balance END,
        NEW.withdrawable_balance,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.float_balance END,
        NEW.float_balance,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.advance_balance END,
        NEW.advance_balance,
        TG_OP
      );
    EXCEPTION WHEN OTHERS THEN
      NULL; -- never block a wallet update because of audit-table issues
    END;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_non_negative_balance() IS
  'Clamps wallets.balance to zero and logs the clamp to wallet_overdraw_events. Clamp preserved for safety; log makes previously-silent phantom drift attributable.';