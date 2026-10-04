-- Store the previous tenant name so the UI can show "previous name → current name".
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS previous_full_name text;

CREATE OR REPLACE FUNCTION public.capture_previous_full_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
    NEW.previous_full_name := OLD.full_name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_previous_full_name ON public.profiles;
CREATE TRIGGER trg_capture_previous_full_name
BEFORE UPDATE OF full_name ON public.profiles
FOR EACH ROW
WHEN (NEW.full_name IS DISTINCT FROM OLD.full_name)
EXECUTE FUNCTION public.capture_previous_full_name();