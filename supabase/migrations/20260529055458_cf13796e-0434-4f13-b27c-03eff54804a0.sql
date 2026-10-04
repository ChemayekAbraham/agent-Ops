-- Secure recipient resolution for wallet-to-wallet (P2P) transfers.
-- Lets any authenticated user resolve a valid transfer recipient by phone OR
-- email WITHOUT being able to read the broad profiles table directly.
-- Returns only the minimal, masked fields the Send Money dialog needs.
CREATE OR REPLACE FUNCTION public.resolve_transfer_recipient(
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  display_name text,
  masked_phone text,
  masked_email text,
  is_self boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH input AS (
    SELECT
      nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '') AS digits,
      nullif(lower(trim(coalesce(p_email, ''))), '')                   AS em
  ),
  norm AS (
    SELECT
      CASE WHEN digits IS NOT NULL AND length(digits) >= 9
           THEN right(digits, 9) ELSE NULL END AS last9,
      em
    FROM input
  )
  SELECT
    pr.id,
    coalesce(nullif(trim(pr.full_name), ''), 'Welile user') AS display_name,
    CASE
      WHEN pr.phone IS NOT NULL
           AND length(regexp_replace(pr.phone, '\D', '', 'g')) >= 3
      THEN repeat('•', greatest(length(regexp_replace(pr.phone, '\D', '', 'g')) - 3, 0))
           || right(regexp_replace(pr.phone, '\D', '', 'g'), 3)
      ELSE NULL
    END AS masked_phone,
    CASE
      WHEN pr.email IS NOT NULL AND position('@' IN pr.email) > 0
      THEN left(pr.email, 1) || '•••' || substring(pr.email FROM position('@' IN pr.email))
      ELSE NULL
    END AS masked_email,
    (pr.id = auth.uid()) AS is_self
  FROM public.profiles pr
  CROSS JOIN norm
  WHERE auth.uid() IS NOT NULL
    AND (
      (norm.last9 IS NOT NULL
        AND right(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), 9) = norm.last9)
      OR
      (norm.em IS NOT NULL
        AND lower(pr.email) = norm.em
        AND pr.phone IS NOT NULL)
    )
  LIMIT 10;
$$;

REVOKE ALL ON FUNCTION public.resolve_transfer_recipient(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_transfer_recipient(text, text) TO authenticated;