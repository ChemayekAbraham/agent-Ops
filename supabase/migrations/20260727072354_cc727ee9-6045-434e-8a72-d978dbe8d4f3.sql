
-- 1) Idempotency flag for the new "house verified" bonus
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS house_verified_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS house_verified_bonus_paid_at timestamptz;

-- 2) Reduce landlord-verified listing bonus from 4,000 to 2,000
CREATE OR REPLACE FUNCTION public.pay_agent_listing_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  listing RECORD;
BEGIN
  IF NEW.verified = true AND (OLD.verified IS NULL OR OLD.verified = false) THEN
    FOR listing IN
      SELECT id, agent_id FROM public.house_listings
      WHERE landlord_id = NEW.id
        AND listing_bonus_paid = false
        AND agent_id IS NOT NULL
    LOOP
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', listing.agent_id,
            'amount', 2000,
            'direction', 'cash_out',
            'category', 'marketing_expense',
            'source_table', 'house_listings',
            'source_id', listing.id::text,
            'description', 'Marketing expense: landlord verified bonus (UGX 2,000)',
            'ledger_scope', 'platform'
          ),
          jsonb_build_object(
            'user_id', listing.agent_id,
            'amount', 2000,
            'direction', 'cash_in',
            'category', 'agent_commission',
            'source_table', 'house_listings',
            'source_id', listing.id::text,
            'description', 'Landlord verified bonus (UGX 2,000)',
            'ledger_scope', 'wallet',
            'recipient_type', 'user'
          )
        ),
        'listing_bonus:' || listing.id::text
      );

      UPDATE public.house_listings
        SET listing_bonus_paid = true, listing_bonus_paid_at = now()
        WHERE id = listing.id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3) New bonus: UGX 2,000 to the listing agent when the HOUSE itself is verified
CREATE OR REPLACE FUNCTION public.pay_agent_house_verified_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.verified, false) = true
     AND COALESCE(OLD.verified, false) = false
     AND NEW.agent_id IS NOT NULL
     AND COALESCE(NEW.status, '') <> 'rejected'
     AND COALESCE(NEW.house_verified_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', NEW.agent_id,
          'amount', 2000,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'source_table', 'house_listings',
          'source_id', NEW.id::text,
          'description', 'Marketing expense: house verified bonus (UGX 2,000)',
          'ledger_scope', 'platform'
        ),
        jsonb_build_object(
          'user_id', NEW.agent_id,
          'amount', 2000,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'source_table', 'house_listings',
          'source_id', NEW.id::text,
          'description', 'House verified bonus (UGX 2,000)',
          'ledger_scope', 'wallet',
          'recipient_type', 'user'
        )
      ),
      'house_verified_bonus:' || NEW.id::text
    );

    NEW.house_verified_bonus_paid := true;
    NEW.house_verified_bonus_paid_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pay_agent_house_verified_bonus ON public.house_listings;
CREATE TRIGGER trg_pay_agent_house_verified_bonus
  BEFORE UPDATE OF verified ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.pay_agent_house_verified_bonus();
