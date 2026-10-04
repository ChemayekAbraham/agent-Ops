-- Create achievements table to store unlocked badges
CREATE TABLE public.user_achievements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  achievement_key TEXT NOT NULL,
  unlocked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb,
  UNIQUE(user_id, achievement_key)
);

-- Enable RLS
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

-- Users can view their own achievements
CREATE POLICY "Users can view their own achievements"
  ON public.user_achievements
  FOR SELECT
  USING (auth.uid() = user_id);

-- System can insert achievements (via trigger)
CREATE POLICY "System can insert achievements"
  ON public.user_achievements
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX idx_user_achievements_user_id ON public.user_achievements(user_id);

-- Create function to check and award streak achievements
CREATE OR REPLACE FUNCTION public.check_payment_streak_achievements()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  consecutive_days INTEGER := 0;
  last_payment_date DATE := NULL;
  payment_record RECORD;
  achievement_awarded BOOLEAN := FALSE;
  achievement_name TEXT;
  achievement_description TEXT;
BEGIN
  -- Calculate consecutive payment days for this tenant
  FOR payment_record IN
    SELECT DISTINCT DATE(payment_date) as pay_date
    FROM public.repayments
    WHERE tenant_id = NEW.tenant_id
    ORDER BY pay_date DESC
  LOOP
    IF last_payment_date IS NULL THEN
      last_payment_date := payment_record.pay_date;
      consecutive_days := 1;
    ELSIF payment_record.pay_date = last_payment_date - 1 THEN
      consecutive_days := consecutive_days + 1;
      last_payment_date := payment_record.pay_date;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- Check for 7-day streak achievement
  IF consecutive_days >= 7 THEN
    INSERT INTO public.user_achievements (user_id, achievement_key, metadata)
    VALUES (NEW.tenant_id, 'streak_7_days', jsonb_build_object('streak_count', consecutive_days))
    ON CONFLICT (user_id, achievement_key) DO NOTHING;
    
    IF FOUND THEN
      achievement_name := '🔥 Week Warrior';
      achievement_description := 'Made payments for 7 consecutive days!';
      achievement_awarded := TRUE;
    END IF;
  END IF;

  -- Check for 14-day streak achievement
  IF consecutive_days >= 14 THEN
    INSERT INTO public.user_achievements (user_id, achievement_key, metadata)
    VALUES (NEW.tenant_id, 'streak_14_days', jsonb_build_object('streak_count', consecutive_days))
    ON CONFLICT (user_id, achievement_key) DO NOTHING;
    
    IF FOUND THEN
      achievement_name := '⭐ Fortnight Champion';
      achievement_description := 'Made payments for 14 consecutive days!';
      achievement_awarded := TRUE;
    END IF;
  END IF;

  -- Check for 30-day streak achievement
  IF consecutive_days >= 30 THEN
    INSERT INTO public.user_achievements (user_id, achievement_key, metadata)
    VALUES (NEW.tenant_id, 'streak_30_days', jsonb_build_object('streak_count', consecutive_days))
    ON CONFLICT (user_id, achievement_key) DO NOTHING;
    
    IF FOUND THEN
      achievement_name := '🏆 Monthly Master';
      achievement_description := 'Made payments for 30 consecutive days!';
      achievement_awarded := TRUE;
    END IF;
  END IF;

  -- Check for first payment achievement
  IF (SELECT COUNT(*) FROM public.repayments WHERE tenant_id = NEW.tenant_id) = 1 THEN
    INSERT INTO public.user_achievements (user_id, achievement_key, metadata)
    VALUES (NEW.tenant_id, 'first_payment', jsonb_build_object('amount', NEW.amount))
    ON CONFLICT (user_id, achievement_key) DO NOTHING;
    
    IF FOUND THEN
      achievement_name := '🎉 First Step';
      achievement_description := 'Made your first payment!';
      achievement_awarded := TRUE;
    END IF;
  END IF;

  -- Send notification for the highest new achievement
  IF achievement_awarded THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.tenant_id,
      'Achievement Unlocked!',
      achievement_name || ' - ' || achievement_description,
      'success',
      jsonb_build_object('achievement_key', 
        CASE 
          WHEN consecutive_days >= 30 THEN 'streak_30_days'
          WHEN consecutive_days >= 14 THEN 'streak_14_days'
          WHEN consecutive_days >= 7 THEN 'streak_7_days'
          ELSE 'first_payment'
        END
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Create trigger to check achievements after each payment
CREATE TRIGGER check_streak_achievements_trigger
  AFTER INSERT ON public.repayments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_payment_streak_achievements();