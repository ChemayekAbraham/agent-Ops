UPDATE auth.users
SET email = 'chelangatandrew404@gmail.com',
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
                        || jsonb_build_object('email', 'chelangatandrew404@gmail.com'),
    email_confirmed_at = COALESCE(email_confirmed_at, now()),
    updated_at = now()
WHERE id = 'b6f6e51a-8757-4e46-beb9-17021c756501';