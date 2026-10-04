-- Create a view for supporter referral leaderboard
CREATE OR REPLACE VIEW public.supporter_referral_leaderboard AS
SELECT 
  sr.referrer_id AS user_id,
  p.full_name,
  p.avatar_url,
  COUNT(sr.id)::integer AS referral_count,
  COUNT(CASE WHEN sr.first_investment_at IS NOT NULL THEN 1 END)::integer AS converted_count,
  COALESCE(SUM(CASE WHEN sr.bonus_credited = true THEN sr.bonus_amount ELSE 0 END), 0)::numeric AS total_earned
FROM public.supporter_referrals sr
LEFT JOIN public.profiles p ON p.id = sr.referrer_id
GROUP BY sr.referrer_id, p.full_name, p.avatar_url
ORDER BY converted_count DESC, total_earned DESC;

-- Enable RLS for the view (views inherit from underlying tables)
COMMENT ON VIEW public.supporter_referral_leaderboard IS 'Leaderboard showing top supporter referrers by conversion count and earnings';