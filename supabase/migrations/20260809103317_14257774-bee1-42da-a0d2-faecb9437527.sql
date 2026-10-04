-- Two-step verification (2MFA) configuration, trusted devices and email challenges

CREATE TABLE public.user_two_factor (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  email TEXT,
  enabled_at TIMESTAMPTZ,
  enabled_device_id TEXT,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.user_two_factor TO authenticated;
GRANT ALL ON public.user_two_factor TO service_role;
ALTER TABLE public.user_two_factor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own two factor settings"
ON public.user_two_factor FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE TABLE public.user_2fa_trusted_devices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_label TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

GRANT SELECT ON public.user_2fa_trusted_devices TO authenticated;
GRANT ALL ON public.user_2fa_trusted_devices TO service_role;
ALTER TABLE public.user_2fa_trusted_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own trusted devices"
ON public.user_2fa_trusted_devices FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE TABLE public.user_2fa_challenges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.user_2fa_challenges TO service_role;
ALTER TABLE public.user_2fa_challenges ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_2fa_challenges_user_device ON public.user_2fa_challenges (user_id, device_id, created_at DESC);
