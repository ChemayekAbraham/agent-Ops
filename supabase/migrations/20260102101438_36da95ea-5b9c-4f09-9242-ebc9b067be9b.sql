-- Create a view for referral leaderboard that aggregates public data
CREATE OR REPLACE VIEW public.referral_leaderboard AS
SELECT 
  p.id as user_id,
  p.full_name,
  p.avatar_url,
  COUNT(r.id) as referral_count,
  COALESCE(SUM(r.bonus_amount), 0) as total_earned
FROM public.profiles p
LEFT JOIN public.referrals r ON r.referrer_id = p.id
GROUP BY p.id, p.full_name, p.avatar_url
HAVING COUNT(r.id) > 0
ORDER BY referral_count DESC;

-- Grant access to the view
GRANT SELECT ON public.referral_leaderboard TO authenticated;
GRANT SELECT ON public.referral_leaderboard TO anon;