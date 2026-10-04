-- Create a function to check and notify managers of onboarding milestones
CREATE OR REPLACE FUNCTION public.notify_onboarding_milestone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_month TEXT;
  target_count INTEGER;
  current_count INTEGER;
  previous_count INTEGER;
  progress_percentage INTEGER;
  previous_percentage INTEGER;
  manager_record RECORD;
  milestone_hit INTEGER := NULL;
BEGIN
  -- Get current month in YYYY-MM-01 format
  current_month := to_char(date_trunc('month', now()), 'YYYY-MM-01');
  
  -- Get the monthly target
  SELECT target_count INTO target_count
  FROM public.onboarding_targets
  WHERE target_month = current_month;
  
  -- If no target set, exit
  IF target_count IS NULL OR target_count = 0 THEN
    RETURN NEW;
  END IF;
  
  -- Count current month's referrals (after this insert)
  SELECT COUNT(*) INTO current_count
  FROM public.referrals
  WHERE created_at >= date_trunc('month', now())
    AND created_at < date_trunc('month', now()) + interval '1 month';
  
  -- Calculate previous count (before this insert)
  previous_count := current_count - 1;
  
  -- Calculate percentages
  progress_percentage := (current_count * 100) / target_count;
  previous_percentage := (previous_count * 100) / target_count;
  
  -- Check which milestone was just crossed
  IF progress_percentage >= 100 AND previous_percentage < 100 THEN
    milestone_hit := 100;
  ELSIF progress_percentage >= 75 AND previous_percentage < 75 THEN
    milestone_hit := 75;
  ELSIF progress_percentage >= 50 AND previous_percentage < 50 THEN
    milestone_hit := 50;
  END IF;
  
  -- If a milestone was hit, notify all managers
  IF milestone_hit IS NOT NULL THEN
    FOR manager_record IN 
      SELECT user_id FROM public.user_roles WHERE role = 'manager'
    LOOP
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        manager_record.user_id,
        CASE milestone_hit
          WHEN 100 THEN '🎉 Target Achieved!'
          WHEN 75 THEN '🔥 75% Milestone!'
          WHEN 50 THEN '📈 Halfway There!'
        END,
        CASE milestone_hit
          WHEN 100 THEN 'Amazing! The team has reached 100% of this month''s onboarding target (' || current_count || '/' || target_count || ' users)!'
          WHEN 75 THEN 'Great progress! The team has reached 75% of this month''s onboarding target (' || current_count || '/' || target_count || ' users).'
          WHEN 50 THEN 'Good momentum! The team is halfway to this month''s onboarding target (' || current_count || '/' || target_count || ' users).'
        END,
        CASE milestone_hit
          WHEN 100 THEN 'success'
          ELSE 'info'
        END,
        jsonb_build_object(
          'milestone', milestone_hit,
          'current_count', current_count,
          'target_count', target_count,
          'month', current_month
        )
      );
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on referrals table
DROP TRIGGER IF EXISTS trigger_onboarding_milestone ON public.referrals;
CREATE TRIGGER trigger_onboarding_milestone
  AFTER INSERT ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_onboarding_milestone();