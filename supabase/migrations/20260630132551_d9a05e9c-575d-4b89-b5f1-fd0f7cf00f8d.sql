ALTER FUNCTION public.auto_create_deposits_from_gmail(integer) RENAME TO auto_create_deposits_from_gmail_impl;

CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail(p_window_hours integer DEFAULT 336)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.auto_create_deposits_from_gmail_impl(p_window_hours);
$$;

SELECT cron.schedule(
  'email-auto-create-deposits-24h',
  '*/2 * * * *',
  $$ SELECT public.auto_create_deposits_from_gmail(336); $$
);