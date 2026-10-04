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
      -- Verification leg only: UGX 4,000. The UGX 1,000 instant leg is paid
      -- separately the moment the house is listed (credit-house-listed-bonus).
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', listing.agent_id,
            'amount', 4000,
            'direction', 'cash_out',
            'category', 'marketing_expense',
            'source_table', 'house_listings',
            'source_id', listing.id::text,
            'description', 'Marketing expense: listing verification bonus - landlord verified',
            'ledger_scope', 'platform'
          ),
          jsonb_build_object(
            'user_id', listing.agent_id,
            'amount', 4000,
            'direction', 'cash_in',
            'category', 'agent_commission',
            'source_table', 'house_listings',
            'source_id', listing.id::text,
            'description', 'Listing verification bonus - landlord verified',
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