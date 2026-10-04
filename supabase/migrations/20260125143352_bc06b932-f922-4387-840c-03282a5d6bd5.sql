-- Update old referral records to reflect correct bonus amount (500 UGX)
UPDATE public.referrals 
SET bonus_amount = 500 
WHERE bonus_amount = 100;