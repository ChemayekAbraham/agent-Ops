INSERT INTO public.treasury_controls (control_key, enabled, updated_at)
VALUES ('payouts_ui_enabled', false, now())
ON CONFLICT (control_key) DO NOTHING;