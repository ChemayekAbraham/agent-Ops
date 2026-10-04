ALTER TABLE public.smartphone_catalog ADD COLUMN os_type text;

UPDATE public.smartphone_catalog
SET os_type = CASE
  WHEN lower(brand) IN ('apple', 'iphone') OR lower(COALESCE(model_name, '')) LIKE '%iphone%' THEN 'ios'
  ELSE 'android'
END;

ALTER TABLE public.smartphone_catalog ALTER COLUMN os_type SET NOT NULL;
ALTER TABLE public.smartphone_catalog ADD CONSTRAINT smartphone_catalog_os_type_check CHECK (os_type IN ('android', 'ios'));