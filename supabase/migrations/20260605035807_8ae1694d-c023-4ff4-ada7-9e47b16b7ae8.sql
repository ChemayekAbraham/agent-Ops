ALTER TABLE public.landlord_leads
  ADD COLUMN IF NOT EXISTS campaign text;

COMMENT ON COLUMN public.landlord_leads.campaign IS 'Marketing campaign/tracking code (e.g. agent-ll-emptyhouse-promo) captured from the signup URL for conversion attribution.';