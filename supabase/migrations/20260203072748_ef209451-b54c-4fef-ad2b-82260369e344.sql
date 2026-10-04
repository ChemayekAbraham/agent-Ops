-- First, delete duplicate referrals keeping only the first one
DELETE FROM public.referrals
WHERE id NOT IN (
  SELECT DISTINCT ON (referrer_id, referred_id) id
  FROM public.referrals
  ORDER BY referrer_id, referred_id, created_at ASC
);

-- Add unique constraint to prevent future duplicates
ALTER TABLE public.referrals 
ADD CONSTRAINT referrals_unique_pair UNIQUE (referrer_id, referred_id);

-- Update the trigger function to handle conflicts gracefully
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bonus_amount NUMERIC := 500;
  referred_user_name TEXT;
  referral_exists BOOLEAN;
BEGIN
  -- Process for ANY user with a referrer_id
  IF NEW.referrer_id IS NOT NULL THEN
    -- Check if referral already exists (prevent duplicate processing)
    SELECT EXISTS(
      SELECT 1 FROM public.referrals 
      WHERE referrer_id = NEW.referrer_id AND referred_id = NEW.id
    ) INTO referral_exists;
    
    IF referral_exists THEN
      -- Already processed, skip
      RETURN NEW;
    END IF;
    
    -- Get the referred user's name
    SELECT full_name INTO referred_user_name FROM public.profiles WHERE id = NEW.id;
    
    -- Create referral record with conflict handling
    INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited, credited_at)
    VALUES (NEW.referrer_id, NEW.id, bonus_amount, true, now())
    ON CONFLICT (referrer_id, referred_id) DO NOTHING;
    
    -- Only credit wallets if we actually inserted (check row count)
    IF FOUND THEN
      -- Credit referrer's wallet
      UPDATE public.wallets
      SET balance = balance + bonus_amount,
          updated_at = now()
      WHERE user_id = NEW.referrer_id;
      
      -- Credit new user's wallet (signup bonus)
      UPDATE public.wallets
      SET balance = balance + bonus_amount,
          updated_at = now()
      WHERE user_id = NEW.id;
      
      -- Create earnings record if referrer is an agent
      IF has_role(NEW.referrer_id, 'agent'::app_role) THEN
        INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description)
        VALUES (NEW.referrer_id, bonus_amount, 'referral_bonus', NEW.id, 'New member registration bonus');
      END IF;
      
      -- Notify the referrer
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        NEW.referrer_id,
        '🎉 New Signup via Your Link!',
        COALESCE(referred_user_name, 'Someone') || ' just signed up using your referral link! You earned UGX ' || bonus_amount || '!',
        'success',
        jsonb_build_object(
          'referred_user_id', NEW.id, 
          'bonus_amount', bonus_amount,
          'referred_name', COALESCE(referred_user_name, 'New User'),
          'send_push', true
        )
      );
      
      -- Notify the new user about their signup bonus
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        NEW.id,
        '🎁 Welcome Bonus!',
        'Welcome to Welile! You received UGX ' || bonus_amount || ' as a signup bonus for joining via a referral link!',
        'success',
        jsonb_build_object(
          'bonus_amount', bonus_amount,
          'bonus_type', 'signup_referral'
        )
      );
      
      -- Send push notification to referrer via edge function
      BEGIN
        PERFORM net.http_post(
          url := current_setting('app.settings.supabase_url', true) || '/functions/v1/send-push-notification',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
          ),
          body := jsonb_build_object(
            'userIds', ARRAY[NEW.referrer_id::text],
            'payload', jsonb_build_object(
              'title', '🎉 New Signup via Your Link!',
              'body', COALESCE(referred_user_name, 'Someone') || ' just signed up using your referral link! +UGX ' || bonus_amount,
              'url', '/dashboard',
              'type', 'referral_signup'
            )
          )
        );
      EXCEPTION
        WHEN OTHERS THEN
          -- Log but don't fail the transaction
          RAISE WARNING 'Push notification failed: %', SQLERRM;
      END;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;