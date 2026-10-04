-- New system event type for photo uploads (committed before runtime use)
ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'listing_photo_added';

-- 1. Child table: many photos per listing (Airbnb/Booking.com pattern)
CREATE TABLE public.listing_photos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES public.house_listings(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT false,
  uploaded_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_listing_photos_listing ON public.listing_photos (listing_id, position);

-- 2. Grants (listings are publicly browsable)
GRANT SELECT ON public.listing_photos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.listing_photos TO authenticated;
GRANT ALL ON public.listing_photos TO service_role;

-- 3. RLS
ALTER TABLE public.listing_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Listing photos are viewable by everyone"
ON public.listing_photos FOR SELECT
USING (true);

CREATE POLICY "Agent or ops can add listing photos"
ON public.listing_photos FOR INSERT TO authenticated
WITH CHECK (
  public.is_ops_role(auth.uid())
  OR EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.id = listing_id AND hl.agent_id = auth.uid())
);

CREATE POLICY "Agent or ops can update listing photos"
ON public.listing_photos FOR UPDATE TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.id = listing_id AND hl.agent_id = auth.uid())
);

CREATE POLICY "Agent or ops can delete listing photos"
ON public.listing_photos FOR DELETE TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.id = listing_id AND hl.agent_id = auth.uid())
);

-- 4. Timestamp trigger
CREATE TRIGGER update_listing_photos_updated_at
BEFORE UPDATE ON public.listing_photos
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Auto position + auto-cover the first photo
CREATE OR REPLACE FUNCTION public.trg_listing_photos_before_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_max INTEGER;
BEGIN
  SELECT COALESCE(MAX(position), -1) INTO v_max FROM public.listing_photos WHERE listing_id = NEW.listing_id;
  IF NEW.position IS NULL OR NEW.position = 0 THEN
    NEW.position := v_max + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listing_photos WHERE listing_id = NEW.listing_id) THEN
    NEW.is_cover := true;
  END IF;
  RETURN NEW;
END$$;

CREATE TRIGGER trg_listing_photos_before_insert
BEFORE INSERT ON public.listing_photos
FOR EACH ROW EXECUTE FUNCTION public.trg_listing_photos_before_insert();

-- 6. Keep house_listings.image_urls in sync (single source of truth = the table)
CREATE OR REPLACE FUNCTION public.sync_house_listing_image_urls(p_listing UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.house_listings hl
  SET image_urls = COALESCE((
        SELECT array_agg(lp.storage_path ORDER BY lp.is_cover DESC, lp.position ASC, lp.created_at ASC)
        FROM public.listing_photos lp WHERE lp.listing_id = p_listing
      ), '{}'),
      updated_at = now()
  WHERE hl.id = p_listing;
END$$;

CREATE OR REPLACE FUNCTION public.trg_listing_photos_sync()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.sync_house_listing_image_urls(OLD.listing_id);
    RETURN OLD;
  END IF;
  PERFORM public.sync_house_listing_image_urls(NEW.listing_id);
  RETURN NEW;
END$$;

CREATE TRIGGER trg_listing_photos_sync
AFTER INSERT OR UPDATE OR DELETE ON public.listing_photos
FOR EACH ROW EXECUTE FUNCTION public.trg_listing_photos_sync();

-- 7. Emit system event on every new photo (trust/activity trail)
CREATE OR REPLACE FUNCTION public.trg_listing_photos_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.system_events (event_type, user_id, related_entity_id, related_entity_type, metadata)
  VALUES ('listing_photo_added', NEW.uploaded_by, NEW.listing_id, 'house_listing',
          jsonb_build_object('photo_id', NEW.id, 'position', NEW.position, 'is_cover', NEW.is_cover));
  RETURN NEW;
END$$;

CREATE TRIGGER trg_listing_photos_event
AFTER INSERT ON public.listing_photos
FOR EACH ROW EXECUTE FUNCTION public.trg_listing_photos_event();

-- 8. Backfill existing photos (triggers disabled to avoid using the new enum value in this transaction)
ALTER TABLE public.listing_photos DISABLE TRIGGER trg_listing_photos_event;
ALTER TABLE public.listing_photos DISABLE TRIGGER trg_listing_photos_sync;
ALTER TABLE public.listing_photos DISABLE TRIGGER trg_listing_photos_before_insert;

INSERT INTO public.listing_photos (listing_id, storage_path, position, is_cover, created_at)
SELECT hl.id, u.url, (u.ord - 1)::int, (u.ord = 1), hl.created_at
FROM public.house_listings hl
CROSS JOIN LATERAL unnest(hl.image_urls) WITH ORDINALITY AS u(url, ord)
WHERE hl.image_urls IS NOT NULL AND array_length(hl.image_urls, 1) > 0;

ALTER TABLE public.listing_photos ENABLE TRIGGER trg_listing_photos_event;
ALTER TABLE public.listing_photos ENABLE TRIGGER trg_listing_photos_sync;
ALTER TABLE public.listing_photos ENABLE TRIGGER trg_listing_photos_before_insert;