CREATE TABLE IF NOT EXISTS public.email_sender_wallet_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_key text NOT NULL UNIQUE,
  sender_label text,
  user_id uuid NOT NULL,
  user_name text,
  user_phone text,
  times_used integer NOT NULL DEFAULT 1,
  last_routed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.email_sender_wallet_bindings TO authenticated;
GRANT ALL ON public.email_sender_wallet_bindings TO service_role;

ALTER TABLE public.email_sender_wallet_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff read sender wallet bindings"
ON public.email_sender_wallet_bindings FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Finance staff create sender wallet bindings"
ON public.email_sender_wallet_bindings FOR INSERT TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Finance staff update sender wallet bindings"
ON public.email_sender_wallet_bindings FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.remember_email_sender_wallet(
  p_sender_key text,
  p_sender_label text,
  p_user_id uuid,
  p_user_name text,
  p_user_phone text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    has_role(auth.uid(), 'financial_ops'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF p_sender_key IS NULL OR btrim(p_sender_key) = '' OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.email_sender_wallet_bindings (
    sender_key, sender_label, user_id, user_name, user_phone, created_by, updated_by
  ) VALUES (
    upper(btrim(p_sender_key)), p_sender_label, p_user_id, p_user_name, p_user_phone, auth.uid(), auth.uid()
  )
  ON CONFLICT (sender_key) DO UPDATE SET
    sender_label = COALESCE(EXCLUDED.sender_label, public.email_sender_wallet_bindings.sender_label),
    user_id = EXCLUDED.user_id,
    user_name = EXCLUDED.user_name,
    user_phone = EXCLUDED.user_phone,
    times_used = CASE
      WHEN public.email_sender_wallet_bindings.user_id = EXCLUDED.user_id
        THEN public.email_sender_wallet_bindings.times_used + 1
      ELSE 1
    END,
    last_routed_at = now(),
    updated_by = auth.uid(),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.remember_email_sender_wallet(text, text, uuid, text, text) TO authenticated;