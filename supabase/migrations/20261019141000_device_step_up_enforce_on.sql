-- Turn on the shared-device sign-in step-up (device-step-up edge function).
-- Set to false to go back to observe-only: devices are still recorded and
-- flagged in get_shared_login_devices, but nobody is asked for a code.
INSERT INTO public.system_config (key, value, updated_at)
VALUES ('device_step_up_enforce', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
