INSERT INTO public.merchandise_share_codes (code, catalog_id)
SELECT 'tstchk', id FROM public.merchandise_catalog ORDER BY created_at LIMIT 1
ON CONFLICT (code) DO NOTHING;