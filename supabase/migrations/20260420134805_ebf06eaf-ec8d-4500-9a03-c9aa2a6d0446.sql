-- One-time password set for user e560295c-e693-432b-bf25-b1403e9539fd (mosescherop1999@gmail.com)
-- Uses pgcrypto bcrypt which Supabase Auth (gotrue) accepts.
UPDATE auth.users
SET 
  encrypted_password = crypt('Welile1234!', gen_salt('bf')),
  email_confirmed_at = COALESCE(email_confirmed_at, now()),
  updated_at = now(),
  raw_app_meta_data = jsonb_set(
    COALESCE(raw_app_meta_data, '{}'::jsonb),
    '{providers}',
    CASE 
      WHEN raw_app_meta_data->'providers' ? 'email' THEN raw_app_meta_data->'providers'
      ELSE COALESCE(raw_app_meta_data->'providers', '[]'::jsonb) || '"email"'::jsonb
    END
  )
WHERE id = 'e560295c-e693-432b-bf25-b1403e9539fd';

-- Ensure an 'email' identity row exists so password login works alongside Apple
INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', u.email, now(), now(), now()
FROM auth.users u
WHERE u.id = 'e560295c-e693-432b-bf25-b1403e9539fd'
  AND NOT EXISTS (
    SELECT 1 FROM auth.identities i 
    WHERE i.user_id = u.id AND i.provider = 'email'
  );