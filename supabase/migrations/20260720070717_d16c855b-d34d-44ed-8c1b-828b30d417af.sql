UPDATE public.system_config
SET value = jsonb_set(value, '{signup_link}', '"https://welileapp.com/ZQhyGb"'::jsonb)
WHERE key = 'momo_sender_signup_sms';