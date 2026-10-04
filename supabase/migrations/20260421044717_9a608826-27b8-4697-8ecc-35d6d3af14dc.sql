-- Reset password using pgcrypto (ensure correct bcrypt) and add email login
UPDATE auth.users
SET encrypted_password = crypt('Welile2026!', gen_salt('bf')),
    email = 'jlukodda@gmail.com',
    email_confirmed_at = COALESCE(email_confirmed_at, now()),
    updated_at = now()
WHERE id = '0c0b9843-b5e8-4960-9785-d8cd0cbcde23';

-- Update the email identity to use the real email so login with jlukodda@gmail.com works
UPDATE auth.identities
SET identity_data = jsonb_set(
      jsonb_set(identity_data, '{email}', '"jlukodda@gmail.com"'),
      '{email_verified}', 'true'
    ),
    provider_id = 'jlukodda@gmail.com',
    updated_at = now()
WHERE user_id = '0c0b9843-b5e8-4960-9785-d8cd0cbcde23'
  AND provider = 'email';