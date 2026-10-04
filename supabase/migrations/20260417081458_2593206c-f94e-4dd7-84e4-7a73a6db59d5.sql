ALTER TABLE public.landlords
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'landlords'
      AND t.tgname = 'update_landlords_updated_at'
      AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER update_landlords_updated_at
    BEFORE UPDATE ON public.landlords
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END
$$;