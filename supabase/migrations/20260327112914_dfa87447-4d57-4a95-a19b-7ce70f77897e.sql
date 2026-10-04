
-- Add short_code column
ALTER TABLE public.house_listings ADD COLUMN IF NOT EXISTS short_code TEXT UNIQUE;

-- Function to generate a random 6-char alphanumeric code
CREATE OR REPLACE FUNCTION public.generate_short_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- Trigger to auto-generate short_code on insert
CREATE OR REPLACE FUNCTION public.auto_assign_short_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_code TEXT;
  attempts INT := 0;
BEGIN
  IF NEW.short_code IS NULL THEN
    LOOP
      new_code := public.generate_short_code();
      -- Check uniqueness
      IF NOT EXISTS (SELECT 1 FROM public.house_listings WHERE short_code = new_code) THEN
        NEW.short_code := new_code;
        EXIT;
      END IF;
      attempts := attempts + 1;
      IF attempts > 10 THEN
        RAISE EXCEPTION 'Could not generate unique short code after 10 attempts';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_short_code
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_short_code();

-- Backfill existing rows
UPDATE public.house_listings
SET short_code = public.generate_short_code()
WHERE short_code IS NULL;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_house_listings_short_code ON public.house_listings (short_code);
