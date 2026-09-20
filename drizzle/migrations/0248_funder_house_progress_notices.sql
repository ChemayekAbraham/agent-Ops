-- Funder progress notices: agent assigned, tenant placed, earning begins.
-- Queue rows carry a full snapshot so the worker needs no extra lookups.

CREATE TABLE IF NOT EXISTS public.funder_house_progress_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('agent_assigned','tenant_placed','earning_started')),
  partner_id uuid NOT NULL,
  supported_house_id uuid,
  house_id uuid,
  commitment_id uuid,
  partner_name text,
  email text,
  phone text,
  house_title text,
  district text,
  house_count integer NOT NULL DEFAULT 1,
  monthly_rent numeric NOT NULL DEFAULT 0,
  principal numeric NOT NULL DEFAULT 0,
  monthly_return numeric NOT NULL DEFAULT 0,
  agent_name text,
  placed_at timestamptz,
  earning_started_at timestamptz,
  sms_sent_at timestamptz,
  sms_error text,
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fhpn_pending
  ON public.funder_house_progress_notices (created_at)
  WHERE sms_sent_at IS NULL OR email_sent_at IS NULL;

GRANT SELECT ON public.funder_house_progress_notices TO authenticated;
GRANT ALL ON public.funder_house_progress_notices TO service_role;

ALTER TABLE public.funder_house_progress_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Funders view own progress notices"
  ON public.funder_house_progress_notices
  FOR SELECT TO authenticated
  USING (partner_id = auth.uid());

CREATE POLICY "Ops view funder progress notices"
  ON public.funder_house_progress_notices
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'partner_ops') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- ---------------------------------------------------------------------------
-- Enqueue helper: writes the queue row plus the in-app notification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_funder_house_notice(
  p_dedupe_key text,
  p_kind text,
  p_partner_id uuid,
  p_supported_house_id uuid,
  p_house_id uuid,
  p_commitment_id uuid,
  p_house_title text,
  p_district text,
  p_house_count integer,
  p_monthly_rent numeric,
  p_principal numeric,
  p_agent_name text,
  p_placed_at timestamptz,
  p_earning_started_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_monthly_return numeric := round(COALESCE(p_principal, 0) * 0.15);
  v_title text;
  v_message text;
  v_house text := COALESCE(NULLIF(p_house_title, ''), 'your funded house');
BEGIN
  IF p_partner_id IS NULL THEN RETURN; END IF;

  SELECT full_name, email, phone INTO v_profile
  FROM public.profiles WHERE id = p_partner_id;

  INSERT INTO public.funder_house_progress_notices (
    dedupe_key, kind, partner_id, supported_house_id, house_id, commitment_id,
    partner_name, email, phone, house_title, district, house_count,
    monthly_rent, principal, monthly_return, agent_name, placed_at, earning_started_at
  ) VALUES (
    p_dedupe_key, p_kind, p_partner_id, p_supported_house_id, p_house_id, p_commitment_id,
    v_profile.full_name, v_profile.email, v_profile.phone, p_house_title, p_district,
    GREATEST(COALESCE(p_house_count, 1), 1), COALESCE(p_monthly_rent, 0),
    COALESCE(p_principal, 0), v_monthly_return, p_agent_name, p_placed_at, p_earning_started_at
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  IF NOT FOUND THEN RETURN; END IF;

  IF p_kind = 'agent_assigned' THEN
    v_title := 'A Welile agent is on your house';
    v_message := COALESCE(NULLIF(p_agent_name, ''), 'A Welile agent')
      || ' has been assigned to ' || v_house
      || ' and is sourcing a tenant. Tenants are placed within 7 days of funding.';
  ELSIF p_kind = 'tenant_placed' THEN
    v_title := 'Tenant placed in your house';
    v_message := 'A tenant has moved into ' || v_house
      || '. Your Returns start as soon as the tenant begins paying rent.';
  ELSE
    v_title := 'Your Returns have started';
    v_message := 'Your money is now working. You are earning about UGX '
      || to_char(v_monthly_return, 'FM999,999,999,999')
      || ' a month in Returns, paid into your Welile wallet.';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, event_key, link_path, metadata)
  VALUES (
    p_partner_id, v_title, v_message, 'success', p_dedupe_key, '/dashboard/funder',
    jsonb_build_object('kind', p_kind, 'house_id', p_house_id, 'supported_house_id', p_supported_house_id)
  )
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_funder_house_notice(text,text,uuid,uuid,uuid,uuid,text,text,integer,numeric,numeric,text,timestamptz,timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Agent assigned / tenant placed, from partner_supported_houses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_funder_house_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_house record;
  v_agent text;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT title, district, monthly_rent INTO v_house
  FROM public.house_listings WHERE id = NEW.house_id;

  IF NEW.listing_agent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.listing_agent_id IS NULL) THEN
    SELECT full_name INTO v_agent FROM public.profiles WHERE id = NEW.listing_agent_id;
    PERFORM public.enqueue_funder_house_notice(
      'agent_assigned:' || NEW.id::text, 'agent_assigned', NEW.partner_id, NEW.id, NEW.house_id,
      NEW.commitment_id, v_house.title, v_house.district, 1, v_house.monthly_rent,
      NEW.principal, v_agent, NULL, NULL
    );
  END IF;

  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR COALESCE(OLD.status, '') <> 'active') THEN
    SELECT full_name INTO v_agent FROM public.profiles WHERE id = NEW.listing_agent_id;
    PERFORM public.enqueue_funder_house_notice(
      'tenant_placed:' || NEW.id::text, 'tenant_placed', NEW.partner_id, NEW.id, NEW.house_id,
      NEW.commitment_id, v_house.title, v_house.district, 1, v_house.monthly_rent,
      NEW.principal, v_agent, COALESCE(NEW.activated_at, now()), NULL
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_funder_house_progress_notices ON public.partner_supported_houses;
CREATE TRIGGER trg_funder_house_progress_notices
  AFTER INSERT OR UPDATE ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public.trg_funder_house_progress();

-- ---------------------------------------------------------------------------
-- Earning begins: first recognised Returns row for a commitment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_funder_earning_started()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_title text;
  v_district text;
  v_rent numeric := 0;
  v_principal numeric := 0;
BEGIN
  SELECT count(*)::int,
         min(hl.title), min(hl.district),
         COALESCE(sum(hl.monthly_rent), 0), COALESCE(sum(psh.principal), 0)
    INTO v_count, v_title, v_district, v_rent, v_principal
  FROM public.partner_supported_houses psh
  LEFT JOIN public.house_listings hl ON hl.id = psh.house_id
  WHERE psh.commitment_id = NEW.commitment_id
    AND psh.status <> 'cancelled';

  IF v_principal <= 0 THEN
    v_principal := COALESCE(NEW.principal, 0);
  END IF;

  PERFORM public.enqueue_funder_house_notice(
    'earning_started:' || NEW.commitment_id::text, 'earning_started', NEW.partner_id,
    NULL, NULL, NEW.commitment_id,
    CASE WHEN v_count > 1 THEN v_count || ' funded houses' ELSE v_title END,
    v_district, GREATEST(v_count, 1), v_rent, v_principal, NULL, NULL,
    COALESCE(NEW.recognized_at, now())
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_funder_earning_started_notice ON public.partner_self_earnings;
CREATE TRIGGER trg_funder_earning_started_notice
  AFTER INSERT ON public.partner_self_earnings
  FOR EACH ROW EXECUTE FUNCTION public.trg_funder_earning_started();
