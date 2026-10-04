-- 1. Landlord verification must not sweep every listing of the landlord into
--    verified/bonus-paid. Restrict the landlord-verified listing bonus to
--    listings that were verified individually (per-house review).
CREATE OR REPLACE FUNCTION public.pay_agent_listing_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  listing RECORD;
BEGIN
  IF NEW.verified = true AND (OLD.verified IS NULL OR OLD.verified = false) THEN
    FOR listing IN
      SELECT id, agent_id FROM public.house_listings
      WHERE landlord_id = NEW.id
        AND listing_bonus_paid = false
        AND agent_id IS NOT NULL
        -- SCOPE FIX: only houses already verified on their own merit.
        AND COALESCE(verified, false) = true
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
$$;

-- 2. Same scope rule for the listed-landlord-verified rent bonus: only rent
--    requests whose attached house is itself verified.
CREATE OR REPLACE FUNCTION public.pay_listed_landlord_verified_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF NEW.verified = true AND (OLD.verified IS DISTINCT FROM true) THEN
    FOR r IN
      SELECT rr.id, rr.agent_id, rr.tenant_id
      FROM public.rent_requests rr
      JOIN public.house_listings hl ON hl.id = rr.house_listing_id
      WHERE rr.landlord_id = NEW.id
        AND rr.house_listing_id IS NOT NULL
        AND rr.agent_id IS NOT NULL
        AND COALESCE(hl.verified, false) = true
    LOOP
      PERFORM public.credit_agent_event_bonus(
        r.agent_id,
        'rent_landlord_verified',
        r.tenant_id,
        'rent_request:' || r.id::text
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Landlord Ops review of a Rent Request verifies ONLY the house attached to
--    that request, using the existing rent_requests.house_listing_id link.
CREATE OR REPLACE FUNCTION public.verify_requested_house_on_landlord_ops_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_ops_reviewed_at IS NOT NULL
     AND OLD.landlord_ops_reviewed_at IS NULL
     AND NEW.house_listing_id IS NOT NULL
  THEN
    UPDATE public.house_listings
       SET verified = true,
           verified_at = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.house_listing_id
       AND COALESCE(verified, false) = false
       AND COALESCE(status, '') <> 'rejected';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_verify_requested_house_on_landlord_ops_review ON public.rent_requests;
CREATE TRIGGER trg_verify_requested_house_on_landlord_ops_review
AFTER UPDATE ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.verify_requested_house_on_landlord_ops_review();