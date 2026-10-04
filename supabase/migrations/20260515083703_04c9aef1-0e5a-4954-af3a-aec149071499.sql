-- Sync landlord pipeline approval with the landlords.verified flag.
--
-- Symptom: a rent request can pass through Landlord Ops → COO → CFO → funded
-- (status = 'landlord_ops_approved' or beyond, landlord_ops_reviewed_at set)
-- yet the agent payout still fails with
--   "Landlord is not verified — Landlord Ops must verify the phone number first."
-- because the payout trigger reads landlords.verified, which the pipeline
-- approval never flipped.
--
-- Fix: (1) auto-flip landlords.verified when Landlord Ops reviews a rent_request,
--      (2) backfill every already-approved landlord whose flag was missed.

-- 1. Trigger function on rent_requests
CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when Landlord Ops has reviewed (stamp present) and the
  -- landlord row is not yet flagged verified.
  IF NEW.landlord_ops_reviewed_at IS NOT NULL
     AND NEW.landlord_id IS NOT NULL THEN

    UPDATE public.landlords
       SET verified    = true,
           verified_at = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.landlord_id
       AND verified IS DISTINCT FROM true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_landlord_verified_on_pipeline_approval
  ON public.rent_requests;

CREATE TRIGGER trg_sync_landlord_verified_on_pipeline_approval
AFTER INSERT OR UPDATE OF landlord_ops_reviewed_at, landlord_ops_reviewed_by, status
ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.sync_landlord_verified_on_pipeline_approval();

-- 2. Backfill every landlord that already passed Landlord Ops but whose
--    landlords.verified flag was never updated.
UPDATE public.landlords l
   SET verified    = true,
       verified_at = COALESCE(l.verified_at, src.first_reviewed_at),
       verified_by = COALESCE(l.verified_by, src.first_reviewer)
  FROM (
    SELECT
      rr.landlord_id,
      MIN(rr.landlord_ops_reviewed_at) AS first_reviewed_at,
      (ARRAY_AGG(rr.landlord_ops_reviewed_by ORDER BY rr.landlord_ops_reviewed_at)
         FILTER (WHERE rr.landlord_ops_reviewed_by IS NOT NULL))[1] AS first_reviewer
    FROM public.rent_requests rr
    WHERE rr.landlord_ops_reviewed_at IS NOT NULL
      AND rr.landlord_id IS NOT NULL
    GROUP BY rr.landlord_id
  ) src
 WHERE l.id = src.landlord_id
   AND l.verified IS DISTINCT FROM true;

-- 3. Audit log marker so CFO/COO can trace the backfill.
INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
SELECT
  'landlord_verified_backfilled_from_pipeline',
  'landlords',
  l.id,
  NULL,
  jsonb_build_object(
    'reason', 'Sync landlord.verified with rent_requests.landlord_ops_reviewed_at — fixes blocked agent payouts after pipeline approval.',
    'verified_at', l.verified_at
  )
FROM public.landlords l
WHERE l.verified = true
  AND l.verified_at >= now() - interval '5 minutes';
