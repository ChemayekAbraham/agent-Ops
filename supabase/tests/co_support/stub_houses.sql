-- House side of the local stub (Phase 4). Live bodies are appended by build_base.js.
INSERT INTO public.pipeline_switches VALUES ('funders_empty_houses', true);

CREATE TABLE public.house_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), landlord_id uuid, agent_id uuid, title text, house_category text,
  monthly_rent int4, region text, district text, sub_county text, village text, latitude float8, longitude float8,
  image_urls text[], status text DEFAULT 'available', tenant_id uuid, verified boolean DEFAULT true,
  is_hidden boolean DEFAULT false, number_of_rooms int, created_at timestamptz DEFAULT now());

CREATE TABLE public.partner_supported_houses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid, house_id uuid, commitment_id uuid, portfolio_id uuid,
  principal numeric, monthly_rate numeric DEFAULT 15, term_months int4 DEFAULT 1, status text DEFAULT 'pending',
  funding_tag text DEFAULT 'self_support_operational_house', landlord_id uuid, listing_agent_id uuid,
  supported_at timestamptz DEFAULT now(), activated_at timestamptz, cancelled_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  rent_amount numeric, proxy_fee numeric DEFAULT 0, proxy_fee_status text, proxy_agent_id uuid, proxy_fee_ledger_group_id uuid);
CREATE UNIQUE INDEX ux_psh_house_live ON public.partner_supported_houses USING btree (house_id)
  WHERE (status = ANY (ARRAY['pending'::text, 'active'::text]));

CREATE TABLE public.promissory_note_house_intents (note_id uuid, house_id uuid, status text, reserved_until timestamptz);
CREATE TABLE public.portfolio_allocations (house_id uuid, status text);

CREATE FUNCTION public.has_role(p_uid uuid, p_role text) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT p_role = 'supporter' AND EXISTS (SELECT 1 FROM public.t_partners WHERE user_id = p_uid) $$;
CREATE FUNCTION public.is_ops_role(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.t_staff WHERE user_id = p_uid) $$;
CREATE FUNCTION public.partner_quote_rate(p_quote_for text, p_partner uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 15::numeric $$;
CREATE FUNCTION public.partner_self_topup_eligibility(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"allow_topup":false}'::jsonb $$;

-- house progress notices (stand-in: one row per notice)
CREATE TABLE public.t_house_notices (kind text, partner uuid, row_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.trg_funder_house_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR COALESCE(OLD.status,'') <> 'active') THEN
    INSERT INTO public.t_house_notices VALUES ('tenant_placed', NEW.partner_id, NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_funder_house_progress_notices AFTER INSERT OR UPDATE ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public.trg_funder_house_progress();
