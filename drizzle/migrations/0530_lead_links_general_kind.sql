ALTER TABLE public.lead_links DROP CONSTRAINT lead_links_kind_check;
ALTER TABLE public.lead_links ADD CONSTRAINT lead_links_kind_check CHECK (kind IN ('partnership','tenant','general'));
INSERT INTO public.lead_links(kind, short_code, destination_path) VALUES ('general','ZQhyGb','/') ON CONFLICT DO NOTHING;