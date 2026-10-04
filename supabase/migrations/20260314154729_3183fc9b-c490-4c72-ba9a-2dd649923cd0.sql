
-- Add caretaker and LC1 chairperson columns to house_listings
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS caretaker_user_id uuid DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS caretaker_name text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS caretaker_phone text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_agent_caretaker boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS landlord_has_smartphone boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS lc1_chairperson_name text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lc1_chairperson_phone text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lc1_chairperson_village text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS listing_bonus_paid boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS listing_bonus_paid_at timestamptz DEFAULT NULL;

-- Create function to auto-pay agent UGX 5,000 when landlord profile is verified
CREATE OR REPLACE FUNCTION public.pay_agent_listing_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  listing RECORD;
  txn_group uuid;
BEGIN
  -- Only fire when landlord becomes verified
  IF NEW.verified = true AND (OLD.verified IS NULL OR OLD.verified = false) THEN
    -- Find all unpaid listings by agents for this landlord
    FOR listing IN
      SELECT id, agent_id FROM public.house_listings
      WHERE landlord_id = NEW.id
        AND listing_bonus_paid = false
    LOOP
      txn_group := gen_random_uuid();
      
      -- Credit agent wallet via general_ledger (triggers sync_wallet_from_ledger)
      INSERT INTO public.general_ledger (
        user_id, amount, direction, category, source_table, source_id,
        description, transaction_date, transaction_group_id, ledger_scope
      ) VALUES (
        listing.agent_id, 5000, 'credit', 'listing_bonus', 'house_listings', listing.id,
        'Listing bonus - landlord verified', now(), txn_group, 'wallet'
      );

      -- Platform expense entry
      INSERT INTO public.general_ledger (
        amount, direction, category, source_table, source_id,
        description, transaction_date, transaction_group_id, ledger_scope
      ) VALUES (
        5000, 'debit', 'listing_bonus_expense', 'house_listings', listing.id,
        'Listing bonus paid to agent', now(), txn_group, 'platform'
      );

      -- Mark as paid
      UPDATE public.house_listings
        SET listing_bonus_paid = true, listing_bonus_paid_at = now()
        WHERE id = listing.id;

      -- Record as agent earning
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, description)
      VALUES (listing.agent_id, 5000, 'listing_bonus', 'House listing bonus - landlord ' || NEW.name || ' verified');
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Attach trigger to landlords table
DROP TRIGGER IF EXISTS trg_pay_listing_bonus ON public.landlords;
CREATE TRIGGER trg_pay_listing_bonus
  AFTER UPDATE ON public.landlords
  FOR EACH ROW
  EXECUTE FUNCTION public.pay_agent_listing_bonus();
