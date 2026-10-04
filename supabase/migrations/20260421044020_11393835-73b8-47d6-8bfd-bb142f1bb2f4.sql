UPDATE auth.users
SET encrypted_password = crypt('Welile2026!', gen_salt('bf')),
    updated_at = now()
WHERE id = '0c0b9843-b5e8-4960-9785-d8cd0cbcde23';