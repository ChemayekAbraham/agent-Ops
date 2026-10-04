DELETE FROM public.suppressed_emails WHERE email = 'bbibantum@gmail.com';
UPDATE public.email_unsubscribe_tokens SET used_at = NULL WHERE email = 'bbibantum@gmail.com';