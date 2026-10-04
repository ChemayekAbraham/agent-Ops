-- 1) Phone normalization helper
CREATE OR REPLACE FUNCTION public.normalize_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN regexp_replace(COALESCE(p, ''), '\D', '', 'g') = '' THEN NULL
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 12
         AND left(regexp_replace(p, '\D', '', 'g'), 3) = '256'
      THEN '0' || right(regexp_replace(p, '\D', '', 'g'), 9)
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 9
      THEN '0' || regexp_replace(p, '\D', '', 'g')
    ELSE regexp_replace(p, '\D', '', 'g')
  END;
$$;

-- 2) Duplicate review list (respects caller RLS)
CREATE OR REPLACE VIEW public.v_lc1_phone_duplicates
WITH (security_invoker = true) AS
WITH norm AS (
  SELECT id, name, phone, village, verified, created_at, verified_at,
         public.normalize_phone(phone) AS np
  FROM public.lc1_chairpersons
),
grp AS (
  SELECT np FROM norm WHERE np IS NOT NULL GROUP BY np HAVING count(*) > 1
)
SELECT n.id,
       n.name,
       n.phone,
       n.village,
       n.verified,
       n.verified_at,
       n.created_at,
       n.np AS normalized_phone,
       (SELECT count(*) FROM public.rent_requests rr WHERE rr.lc1_id = n.id) AS rent_request_count
FROM norm n
JOIN grp g ON g.np = n.np;

GRANT SELECT ON public.v_lc1_phone_duplicates TO authenticated;

-- 3) Merge duplicates into a canonical record (ops only)
CREATE OR REPLACE FUNCTION public.merge_lc1_duplicates(
  p_canonical_id uuid,
  p_duplicate_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved_requests int := 0;
  v_deleted int := 0;
  v_any_verified boolean;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to merge LC1 chairperson records';
  END IF;

  IF p_canonical_id IS NULL OR p_duplicate_ids IS NULL OR array_length(p_duplicate_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'A canonical record and at least one duplicate are required';
  END IF;

  IF p_canonical_id = ANY(p_duplicate_ids) THEN
    RAISE EXCEPTION 'The canonical record cannot also be listed as a duplicate';
  END IF;

  -- Repoint linked rent requests onto the canonical record
  UPDATE public.rent_requests
    SET lc1_id = p_canonical_id
    WHERE lc1_id = ANY(p_duplicate_ids);
  GET DIAGNOSTICS v_moved_requests = ROW_COUNT;

  -- Remove leftover verification requests tied to the duplicates
  DELETE FROM public.lc1_verification_requests WHERE lc1_id = ANY(p_duplicate_ids);

  -- Carry verified status onto the canonical record if any record in the set is verified
  SELECT bool_or(verified) INTO v_any_verified
    FROM public.lc1_chairpersons
    WHERE id = p_canonical_id OR id = ANY(p_duplicate_ids);

  IF v_any_verified THEN
    UPDATE public.lc1_chairpersons
      SET verified = true,
          verified_at = COALESCE(verified_at, now())
      WHERE id = p_canonical_id AND verified = false;
  END IF;

  -- Delete the duplicate records
  DELETE FROM public.lc1_chairpersons WHERE id = ANY(p_duplicate_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'canonical_id', p_canonical_id,
    'moved_rent_requests', v_moved_requests,
    'deleted', v_deleted
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_lc1_duplicates(uuid, uuid[]) TO authenticated;

-- 4) Block creating a new LC1 chairperson with a phone that already exists
CREATE OR REPLACE FUNCTION public.block_duplicate_lc1_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_name text;
BEGIN
  SELECT name INTO v_existing_name
  FROM public.lc1_chairpersons
  WHERE public.normalize_phone(phone) = public.normalize_phone(NEW.phone)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'LC1_DUPLICATE: An LC1 chairperson with phone % already exists (%).', NEW.phone, v_existing_name
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_duplicate_lc1_phone ON public.lc1_chairpersons;
CREATE TRIGGER trg_block_duplicate_lc1_phone
  BEFORE INSERT ON public.lc1_chairpersons
  FOR EACH ROW EXECUTE FUNCTION public.block_duplicate_lc1_phone();