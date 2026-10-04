-- 1. Remove roles + profile from the abandoned duplicate account (frees the phone number)
DELETE FROM public.user_roles WHERE user_id = '120f3695-6f35-4aad-abdf-2c54620d8c42';
DELETE FROM public.profiles  WHERE id      = '120f3695-6f35-4aad-abdf-2c54620d8c42';

-- 2. Create the verified, searchable profile on the account that holds the 500,000 deposit
INSERT INTO public.profiles (id, full_name, phone, email, verified, wallet_id, created_at, updated_at)
SELECT
  '733f7a98-f077-4cdd-9211-4ea458a3ef43',
  'Ssembatya Marvin',
  '0702071819',
  '256702071819@welile.user',
  true,
  (SELECT id FROM public.wallets WHERE user_id = '733f7a98-f077-4cdd-9211-4ea458a3ef43' LIMIT 1),
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles WHERE id = '733f7a98-f077-4cdd-9211-4ea458a3ef43'
);

UPDATE public.profiles
SET verified = true, updated_at = now()
WHERE id = '733f7a98-f077-4cdd-9211-4ea458a3ef43';

-- 3. Restore his previous roles on the active account
INSERT INTO public.user_roles (user_id, role)
VALUES
  ('733f7a98-f077-4cdd-9211-4ea458a3ef43', 'tenant'),
  ('733f7a98-f077-4cdd-9211-4ea458a3ef43', 'agent'),
  ('733f7a98-f077-4cdd-9211-4ea458a3ef43', 'landlord')
ON CONFLICT (user_id, role) DO NOTHING;