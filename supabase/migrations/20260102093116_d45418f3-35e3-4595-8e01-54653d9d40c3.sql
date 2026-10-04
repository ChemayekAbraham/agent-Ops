-- Update the credit_referral_bonus function to work for ALL users, not just agents
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bonus_amount NUMERIC := 100;
BEGIN
  -- Process for ANY user with a referrer_id (not just agents)
  IF NEW.referrer_id IS NOT NULL THEN
    -- Create referral record
    INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited, credited_at)
    VALUES (NEW.referrer_id, NEW.id, bonus_amount, true, now());
    
    -- Credit referrer's wallet
    UPDATE public.wallets
    SET balance = balance + bonus_amount,
        updated_at = now()
    WHERE user_id = NEW.referrer_id;
    
    -- Create earnings record if referrer is an agent
    IF has_role(NEW.referrer_id, 'agent'::app_role) THEN
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description)
      VALUES (NEW.referrer_id, bonus_amount, 'referral_bonus', NEW.id, 'New member registration bonus');
    END IF;
    
    -- Notify the referrer
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      '🎉 Referral Bonus!',
      'You earned UGX ' || bonus_amount || ' for inviting a new member to Welile!',
      'success',
      jsonb_build_object('referred_user_id', NEW.id, 'bonus_amount', bonus_amount)
    );
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Update RLS policy on referrals table to allow all users to view their referrals
DROP POLICY IF EXISTS "Agents can view own referrals" ON public.referrals;
DROP POLICY IF EXISTS "Users can view own referrals" ON public.referrals;

CREATE POLICY "Users can view own referrals" 
ON public.referrals 
FOR SELECT 
USING (auth.uid() = referrer_id);

-- Enable realtime for referrals and wallets tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.referrals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets;