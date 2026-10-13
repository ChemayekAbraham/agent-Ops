ALTER TABLE public.tenant_campaign_sends ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX tenant_campaign_sends_dedupe ON public.tenant_campaign_sends (campaign_id, dedupe_key);