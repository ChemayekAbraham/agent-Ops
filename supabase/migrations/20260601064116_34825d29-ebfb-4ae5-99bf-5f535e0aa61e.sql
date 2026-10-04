-- =====================================================================
-- Concurrency lock: two agents cannot assign the same empty house.
-- =====================================================================

-- 1. Reservation mirror columns on house_listings (drives the picker filter)
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS reserved_by uuid,
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz;

-- 2. HARD LOCK: only ONE pending invite may hold a given house at a time.
--    A second concurrent invite for the same house fails with 23505.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_invite_house_listing
  ON public.supporter_invites (house_listing_id)
  WHERE status = 'pending' AND house_listing_id IS NOT NULL;

-- 3. Keep the house reservation mirror in sync with pending invites so the
--    available-house picker hides any house currently held by another agent.
CREATE OR REPLACE FUNCTION public.sync_house_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    -- Pending invite holding a house → mark reserved (only if not yet occupied)
    IF NEW.house_listing_id IS NOT NULL AND NEW.status = 'pending' THEN
      UPDATE public.house_listings
         SET reserved_by = NEW.created_by,
             reserved_at = COALESCE(reserved_at, now())
       WHERE id = NEW.house_listing_id
         AND tenant_id IS NULL;
    END IF;

    -- Invite left pending OR re-pointed to a different house → release old hold
    IF TG_OP = 'UPDATE' AND OLD.house_listing_id IS NOT NULL
       AND (NEW.status <> 'pending'
            OR NEW.house_listing_id IS DISTINCT FROM OLD.house_listing_id) THEN
      UPDATE public.house_listings
         SET reserved_by = NULL, reserved_at = NULL
       WHERE id = OLD.house_listing_id
         AND tenant_id IS NULL;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.house_listing_id IS NOT NULL THEN
    UPDATE public.house_listings
       SET reserved_by = NULL, reserved_at = NULL
     WHERE id = OLD.house_listing_id
       AND tenant_id IS NULL;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_house_reservation ON public.supporter_invites;
CREATE TRIGGER trg_sync_house_reservation
AFTER INSERT OR UPDATE OR DELETE ON public.supporter_invites
FOR EACH ROW
EXECUTE FUNCTION public.sync_house_reservation();

-- 4. Backfill reservations for any houses already held by existing pending invites
UPDATE public.house_listings hl
   SET reserved_by = si.created_by,
       reserved_at = COALESCE(hl.reserved_at, si.created_at)
  FROM public.supporter_invites si
 WHERE si.house_listing_id = hl.id
   AND si.status = 'pending'
   AND hl.tenant_id IS NULL;