CREATE OR REPLACE FUNCTION public.process_monthly_referral_rewards()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  reward_date DATE := date_trunc('month', now() - interval '1 month')::date;
  top_referrer RECORD;
  reward_amounts INTEGER[] := ARRAY[3000, 2000, 1000];
  current_rank INTEGER := 1;
BEGIN
  FOR top_referrer IN
    SELECT
      r.referrer_id as user_id,
      COUNT(*) as referral_count
    FROM public.referrals r
    WHERE r.created_at >= date_trunc('month', now() - interval '1 month')
      AND r.created_at < date_trunc('month', now())
      AND r.credited = true
    GROUP BY r.referrer_id
    ORDER BY COUNT(*) DESC
    LIMIT 3
  LOOP
    IF top_referrer.referral_count > 0 THEN
      INSERT INTO public.referral_rewards (user_id, reward_month, rank, reward_amount, referral_count, credited, credited_at)
      VALUES (top_referrer.user_id, reward_date, current_rank, reward_amounts[current_rank], top_referrer.referral_count, true, now())
      ON CONFLICT (user_id, reward_month) DO NOTHING;

      UPDATE public.wallets
      SET balance = balance + reward_amounts[current_rank],
          updated_at = now()
      WHERE user_id = top_referrer.user_id;

      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        top_referrer.user_id,
        '🏆 Monthly Referral Reward!',
        'Congratulations! You ranked #' || current_rank || ' in last month''s referral leaderboard and earned UGX ' || reward_amounts[current_rank] || '!',
        'success',
        jsonb_build_object('rank', current_rank, 'reward_amount', reward_amounts[current_rank], 'month', reward_date)
      );

      current_rank := current_rank + 1;
    END IF;
  END LOOP;
END;
$function$;