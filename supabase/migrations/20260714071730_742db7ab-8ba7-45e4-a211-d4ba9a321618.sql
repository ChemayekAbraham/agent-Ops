ALTER TABLE public.partner_agreements
  ADD COLUMN IF NOT EXISTS partner_signature_data_url text;

COMMENT ON COLUMN public.partner_agreements.partner_signature_data_url IS
  'PNG data URL of the partner''s handwritten signature captured at onboarding. Rendered into the executed/countersigned agreement PDF.';