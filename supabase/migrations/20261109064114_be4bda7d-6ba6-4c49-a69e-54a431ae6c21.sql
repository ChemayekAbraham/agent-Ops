ALTER TABLE public.welile_signages ADD COLUMN IF NOT EXISTS gps_source text, ADD COLUMN IF NOT EXISTS repeat_owner_phone boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX welile_signages_unique_gps ON public.welile_signages(gps_latitude, gps_longitude);
CREATE OR REPLACE FUNCTION public._welile_signages_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF TG_OP='INSERT' OR (OLD.status='changes_required' AND NEW.status='submitted') THEN
  IF NEW.gps_source IS DISTINCT FROM 'device' OR NEW.gps_latitude IS NULL OR NEW.gps_longitude IS NULL OR NEW.gps_latitude NOT BETWEEN -90 AND 90 OR NEW.gps_longitude NOT BETWEEN -180 AND 180 OR NEW.gps_accuracy_meters IS NULL OR NEW.gps_accuracy_meters < 0 OR NEW.gps_captured_at IS NULL THEN
   RAISE EXCEPTION 'Real device GPS is required. Stand at the property and capture GPS again.';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.review_notes IS DISTINCT FROM OLD.review_notes OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason OR NEW.coo_review_notes IS DISTINCT FROM OLD.coo_review_notes OR NEW.photos IS DISTINCT FROM OLD.photos OR NEW.installation_photos IS DISTINCT FROM OLD.installation_photos OR NEW.installed_at IS DISTINCT FROM OLD.installed_at OR NEW.installer_name IS DISTINCT FROM OLD.installer_name OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
  RAISE EXCEPTION 'Active signages are read-only in Ops review.';
 END IF;
 IF TG_OP='UPDATE' AND NEW.status='active' AND OLD.status<>'active' THEN
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.installation_photos) photo WHERE photo->>'category'='installed_signage' AND coalesce(photo->>'url','') ~ '^(data:image/(webp|jpeg|png);base64,|https://)') THEN
   RAISE EXCEPTION 'Add a photo of the installed board before activating billing.';
  END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.owner_phone IS DISTINCT FROM OLD.owner_phone THEN
  NEW.repeat_owner_phone := EXISTS(SELECT 1 FROM public.welile_signages s WHERE s.id<>NEW.id AND right(regexp_replace(s.owner_phone,'[^0-9]','','g'),9)=right(regexp_replace(NEW.owner_phone,'[^0-9]','','g'),9));
 ELSE
  NEW.repeat_owner_phone := OLD.repeat_owner_phone;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public._welile_signages_evidence_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_signages_evidence_guard BEFORE INSERT OR UPDATE ON public.welile_signages FOR EACH ROW EXECUTE FUNCTION public._welile_signages_evidence_guard();
ALTER POLICY "signages agent update own pending" ON public.welile_signages USING (agent_id=(SELECT auth.uid()) AND status IN ('submitted','pending','changes_required','rejected')) WITH CHECK (agent_id=(SELECT auth.uid()) AND status IN ('submitted','pending','cancelled'));
CREATE OR REPLACE FUNCTION public._welile_signages_agent_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NOT public.welile_signages_ops_ok() AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF NOT ((OLD.status='changes_required' AND NEW.status='submitted') OR (OLD.status IN ('submitted','pending','changes_required','rejected') AND NEW.status='cancelled')) THEN
   RAISE EXCEPTION 'Agents may only resubmit Changes Required applications or cancel pending or declined spots.';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public._welile_signages_agent_transition_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_signages_agent_transition_guard BEFORE UPDATE ON public.welile_signages FOR EACH ROW EXECUTE FUNCTION public._welile_signages_agent_transition_guard();