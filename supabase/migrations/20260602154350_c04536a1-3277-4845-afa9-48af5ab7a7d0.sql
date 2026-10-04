-- Configurable thank-you SMS template for incoming MoMo (MTN/Airtel) senders.
-- Stored in the existing key-value system_config table so wording can be
-- edited without redeploying the gmail-poll-transactions edge function.
INSERT INTO public.system_config (key, value)
VALUES (
  'momo_sender_signup_sms',
  jsonb_build_object(
    'enabled', true,
    'thank_you_text', 'Thank you for sending {amount} via {provider}.',
    'signup_prompt', 'Open your free Welile Wallet with any phone number here:',
    'signup_link', 'https://welileapp.com/auth?signup=1',
    'address', 'Welile HQ, P.O. Box 167564, Palm Lane, Kabaale, Entebbe - Uganda.',
    'website', 'welile.com',
    'support_email', 'info@welile.com'
  )
)
ON CONFLICT (key) DO NOTHING;

-- Allow executives/managers to update this specific key from the UI.
CREATE POLICY "Executives update momo_sender_signup_sms"
ON public.system_config
FOR UPDATE
TO authenticated
USING (
  key = 'momo_sender_signup_sms'
  AND (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
  )
)
WITH CHECK (
  key = 'momo_sender_signup_sms'
  AND (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
  )
);