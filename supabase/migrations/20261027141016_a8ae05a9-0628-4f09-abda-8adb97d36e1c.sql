CREATE TABLE public.landlord_rejected_number_locks (
 landlord_id uuid PRIMARY KEY REFERENCES public.landlords(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.landlord_rejected_number_locks TO service_role;
ALTER TABLE public.landlord_rejected_number_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_required_for_staff ON public.landlord_rejected_number_locks AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
INSERT INTO public.landlord_rejected_number_locks (landlord_id)
SELECT DISTINCT landlord_id FROM (
 SELECT landlord_id FROM public.rent_requests WHERE landlord_id IS NOT NULL AND (status = 'rejected' OR rejected_at IS NOT NULL)
 UNION SELECT landlord_id FROM public.landlord_verification_requests WHERE landlord_id IS NOT NULL AND status = 'rejected'
) rejected ON CONFLICT (landlord_id) DO NOTHING;

CREATE FUNCTION public.remember_landlord_number_rejection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF NEW.status = 'rejected' AND NEW.landlord_id IS NOT NULL THEN
  INSERT INTO public.landlord_rejected_number_locks (landlord_id) VALUES (NEW.landlord_id) ON CONFLICT (landlord_id) DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.remember_landlord_number_rejection() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER remember_rent_landlord_number_rejection AFTER INSERT OR UPDATE OF status, landlord_id ON public.rent_requests FOR EACH ROW EXECUTE FUNCTION public.remember_landlord_number_rejection();
CREATE TRIGGER remember_verification_landlord_number_rejection AFTER INSERT OR UPDATE OF status, landlord_id ON public.landlord_verification_requests FOR EACH ROW EXECUTE FUNCTION public.remember_landlord_number_rejection();

CREATE FUNCTION public.guard_rejected_landlord_number() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_changed boolean; v_landlord uuid;
BEGIN
 IF TG_TABLE_NAME = 'landlords' THEN
  v_landlord := OLD.id;
  v_changed := public.landlord_number_norm(NEW.phone) IS DISTINCT FROM public.landlord_number_norm(OLD.phone)
   OR public.landlord_number_norm(NEW.mobile_money_number) IS DISTINCT FROM public.landlord_number_norm(OLD.mobile_money_number)
   OR public.landlord_number_norm(NEW.verified_mobile_money_number) IS DISTINCT FROM public.landlord_number_norm(OLD.verified_mobile_money_number);
 ELSE
  v_landlord := OLD.landlord_id;
  v_changed := public.landlord_number_norm(NEW.landlord_phone) IS DISTINCT FROM public.landlord_number_norm(OLD.landlord_phone);
 END IF;
 IF v_changed AND EXISTS (SELECT 1 FROM public.landlord_rejected_number_locks WHERE landlord_id = v_landlord)
    AND NOT (auth.uid() IS NOT NULL AND public._has_enabled_role(auth.uid(), ARRAY['landlord_ops'])) THEN
  RAISE EXCEPTION 'Only Landlord Ops can change the landlord number after a request has been rejected.' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_rejected_landlord_number() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_a00_rejected_landlord_number BEFORE UPDATE OF phone, mobile_money_number, verified_mobile_money_number ON public.landlords FOR EACH ROW EXECUTE FUNCTION public.guard_rejected_landlord_number();
CREATE TRIGGER trg_a00_rejected_verification_landlord_number BEFORE UPDATE OF landlord_phone ON public.landlord_verification_requests FOR EACH ROW EXECUTE FUNCTION public.guard_rejected_landlord_number();