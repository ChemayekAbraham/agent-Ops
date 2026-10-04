
CREATE OR REPLACE FUNCTION public.enforce_unique_landlord_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
  v_existing_name text;
BEGIN
  IF NEW.phone IS NULL OR btrim(NEW.phone) = '' THEN
    RETURN NEW;
  END IF;

  v_norm := RIGHT(regexp_replace(NEW.phone, '\D', '', 'g'), 9);
  IF v_norm IS NULL OR length(v_norm) < 9 THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_existing_name
  FROM public.landlords
  WHERE id <> NEW.id
    AND RIGHT(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 9) = v_norm
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Registration failed. A landlord with this phone number is already registered.%',
      CASE WHEN v_existing_name IS NOT NULL THEN ' (existing: ' || v_existing_name || ')' ELSE '' END
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_unique_landlord_phone ON public.landlords;
CREATE TRIGGER trg_enforce_unique_landlord_phone
BEFORE INSERT ON public.landlords
FOR EACH ROW EXECUTE FUNCTION public.enforce_unique_landlord_phone();
