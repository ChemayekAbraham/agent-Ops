-- Fix Benjamin Muhanguzi's wallet balance to match ledger truth
UPDATE public.wallets 
SET balance = 4504800, updated_at = now() 
WHERE user_id = 'cf561688-b3a2-4f62-b9c1-67ee7b36ff2b' 
AND balance = 0;