-- Co-support, Phase 4: two partners share one EMPTY HOUSE 50/50.
--
-- Same invitation as Rent Plans (Phase 1: 20261115090000_co_support_phase1):
-- a 48-hour link, exact halves, operational float only, contract first.
-- Houses differ in three ways, and this file follows the one-partner house path:
--   * There is no tenant, so no landlord float is released. The money is
--     operational capital for the verified house (supporter_rent_fund).
--   * One-partner house support waits for Partner Ops approval. A shared
--     house does too, but AS A PAIR: approving either half approves both in
--     one transaction (both wallets debited), rejecting either rejects both.
--     Until then each half is a pending portfolio, so each partner's half is
--     held on their float (funder_pending_hold), exactly like one partner.
--   * Empty-house funding follows pipeline switch funders_empty_houses (the
--     trg_e34 guard); co-support houses follow the same switch.
-- After approval, cancelling either half's row cancels both and records both
-- refunds (finance step), like Rent Plans.
--
-- Changed live objects (bodies taken from production 2026-11-11, md5-checked):
--   agent_list_empty_house_opportunities  + hide houses with an open invite
--   house_has_live_claim                  + an open invite is a live claim
--   approve_pending_portfolio             + approve the other half of a pair
--   reject_pending_portfolio              + reject the other half of a pair
--   ux_psh_house_live                     one row per house, except co-support
-- Co-support functions from Phase 1 are replaced with house-aware versions.

SET client_encoding = 'UTF8';
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Invites can point at a house instead of a Rent Plan
-- ---------------------------------------------------------------------------
ALTER TABLE public.co_support_invites ADD COLUMN IF NOT EXISTS house_id uuid;
ALTER TABLE public.co_support_invites ALTER COLUMN rent_request_id DROP NOT NULL;
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_one_target;
ALTER TABLE public.co_support_invites
  ADD CONSTRAINT co_support_one_target CHECK (num_nonnulls(rent_request_id, house_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS ux_co_support_one_open_per_house
  ON public.co_support_invites (house_id) WHERE status = 'open' AND house_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Supported-house rows: one per house, except a co-supported house (one per partner)
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_supported_houses
  ADD COLUMN IF NOT EXISTS co_support_id uuid REFERENCES public.co_support_invites(id);

DROP INDEX IF EXISTS public.ux_psh_house_live;
CREATE UNIQUE INDEX ux_psh_house_live
  ON public.partner_supported_houses (house_id)
  WHERE status = ANY (ARRAY['pending'::text, 'active'::text]) AND co_support_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_psh_house_live_co_support
  ON public.partner_supported_houses (house_id, partner_id)
  WHERE status = ANY (ARRAY['pending'::text, 'active'::text]) AND co_support_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psh_co_support
  ON public.partner_supported_houses (co_support_id) WHERE co_support_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._psh_no_mixed_support()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'active') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_supported_houses s
     WHERE s.house_id = NEW.house_id
       AND s.id <> NEW.id
       AND s.status IN ('pending', 'active')
       AND (s.co_support_id IS DISTINCT FROM NEW.co_support_id)
  ) THEN
    RAISE EXCEPTION 'HOUSE_ALREADY_SUPPORTED: this house already has a different supporter'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._psh_no_mixed_support() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_psh_no_mixed_support ON public.partner_supported_houses;
CREATE TRIGGER trg_psh_no_mixed_support
  BEFORE INSERT OR UPDATE OF house_id, co_support_id, status ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public._psh_no_mixed_support();

-- ---------------------------------------------------------------------------
-- 3. An open house invitation is a live claim, and hides the house from the feed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.house_has_live_claim(p_house_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    -- 1. A funder picked it through the promissory-note flow.
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id AND i.status IN ('reserved','funded')
    UNION ALL
    -- 2. A partner is self-supporting it.
    SELECT 1 FROM public.partner_supported_houses psh
     WHERE psh.house_id = p_house_id AND psh.status IN ('pending','active')
    UNION ALL
    -- 3. A company-managed portfolio claimed it.
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id AND a.status IN ('reserved','fulfilled')
    UNION ALL
    -- 4. Co-support: a partner is inviting another partner to share it (48 hours).
    SELECT 1 FROM public.co_support_invites ci
     WHERE ci.house_id = p_house_id AND ci.status = 'open' AND ci.expires_at > now()
  );
$function$;

@@FEED@@

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_expire_stale(p_rent_request_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  -- p_rent_request_id is the target: a Rent Plan id or a house id.
  UPDATE public.co_support_invites
     SET status = 'expired', closed_at = now(), close_reason = 'expired', updated_at = now()
   WHERE status = 'open'
     AND expires_at <= now()
     AND (p_rent_request_id IS NULL OR rent_request_id = p_rent_request_id OR house_id = p_rent_request_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public._co_support_require_partner_house(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_uid IS NULL OR NOT public.psm_is_partner(p_uid) THEN
    RAISE EXCEPTION 'NOT_A_PARTNER: Finish your partner sign-up first.' USING ERRCODE = '42501';
  END IF;
  IF NOT public._pipeline_switch_on('funders_empty_houses') THEN
    RAISE EXCEPTION 'CO_SUPPORT_UNAVAILABLE: Supporting an empty house is paused right now.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.funder_has_signed_agreement(p_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED: Sign your partnership agreement first.'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- NULL when the house can be supported; otherwise a reason code.
-- (The same rules partner_support_houses applies to one partner.)
CREATE OR REPLACE FUNCTION public._co_support_house_problem(p_house_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  h record;
BEGIN
  SELECT * INTO h FROM public.house_listings WHERE id = p_house_id;
  IF NOT FOUND THEN RETURN 'house_not_found'; END IF;
  IF NOT COALESCE(h.verified, false) OR h.status <> 'available' OR h.tenant_id IS NOT NULL
     OR COALESCE(h.is_hidden, false) OR COALESCE(h.monthly_rent, 0) <= 0 THEN
    RETURN 'house_not_available';
  END IF;
  IF public.house_has_live_claim(p_house_id) THEN
    RETURN 'house_taken';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._co_support_house_lead_checks(p_lead uuid, p_house_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  s record;
  v_rent numeric;
  v_avail numeric;
BEGIN
  IF public._co_support_house_problem(p_house_id) IS NOT NULL THEN
    RAISE EXCEPTION 'HOUSE_NOT_AVAILABLE: This house is no longer available. Choose another one.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT monthly_rent::numeric INTO v_rent FROM public.house_listings WHERE id = p_house_id;
  SELECT * INTO s FROM public._co_support_split(v_rent);

  IF s.invitee_rent < 50000 THEN
    RAISE EXCEPTION 'CO_SUPPORT_PLAN_TOO_SMALL: Each half must be at least UGX 50,000, so only houses with a monthly rent of UGX 100,000 or more can be shared.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(p_lead);

  v_avail := public.funder_float_available(p_lead);
  IF v_avail < s.lead_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then share again.',
      public._co_support_fmt(s.lead_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN jsonb_build_object('rent', v_rent, 'gross', s.gross,
                            'lead_rent', s.lead_rent, 'invitee_rent', s.invitee_rent,
                            'lead_share', s.lead_share, 'invitee_share', s.invitee_share);
END;
$$;

-- One half of a house: its own commitment, portfolio, pending row and
-- supported-house row (the rows partner_support_houses writes for one partner).
CREATE OR REPLACE FUNCTION public._co_support_open_house_half(
  p_invite_id uuid, p_partner uuid, p_rent numeric, p_gross numeric, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rate numeric := public.partner_rate_now(p_partner);
  v_term integer := public.psm_contract_term_months();
  v_key text := 'cosup-' || p_invite_id::text || '-' || p_role;
  v_commitment uuid;
  v_agent uuid;
  v_code text;
  v_portfolio uuid;
  v_stored numeric;
  v_row uuid;
  h record;
BEGIN
  SELECT hl.id, hl.landlord_id, hl.agent_id INTO h
    FROM public.co_support_invites i JOIN public.house_listings hl ON hl.id = i.house_id
   WHERE i.id = p_invite_id;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (p_partner, p_gross, v_term, v_rate, 1, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, p_gross, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio, p_partner, p_gross, 'self_managed_house', v_commitment, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months, status, landlord_id, listing_agent_id, metadata, co_support_id
  ) VALUES (
    p_partner, h.id, v_commitment, v_portfolio, p_gross, p_rent, p_gross - p_rent,
    CASE WHEN p_gross > p_rent THEN 'pending' END,
    v_rate, v_term, 'pending', h.landlord_id, h.agent_id,
    jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'co_support', true, 'role', p_role),
    p_invite_id
  ) RETURNING id INTO v_row;

  PERFORM public.psm_audit(COALESCE(auth.uid(), p_partner), p_partner, 'co_support_house_half_pending_ops_approval',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('co_support_id', p_invite_id, 'role', p_role, 'amount', p_gross,
                       'rent_amount', p_rent, 'proxy_fee', p_gross - p_rent,
                       'portfolio_id', v_portfolio, 'house_id', h.id, 'term_months', v_term));

  RETURN jsonb_build_object('commitment_id', v_commitment, 'portfolio_id', v_portfolio,
                            'row_id', v_row, 'rate', v_rate);
END;
$$;

-- The other half(s) of a co-supported house still waiting for Partner Ops.
CREATE OR REPLACE FUNCTION public._co_support_pair_pending_portfolios(p_portfolio_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT o.portfolio_id
    FROM public.funder_pending_portfolios f
    JOIN public.partner_supported_houses me ON me.commitment_id = f.commitment_id AND me.co_support_id IS NOT NULL
    JOIN public.partner_supported_houses o ON o.co_support_id = me.co_support_id AND o.commitment_id <> f.commitment_id
    JOIN public.funder_pending_portfolios fo ON fo.portfolio_id = o.portfolio_id AND fo.status = 'pending'
    JOIN public.investor_portfolios ip ON ip.id = o.portfolio_id
   WHERE f.portfolio_id = p_portfolio_id
     AND ip.status IN ('pending_ops_approval', 'awaiting_partner_details');
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public._co_support_expire_stale(uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_require_partner_house(uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_house_problem(uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_house_lead_checks(uuid, uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_open_house_half(uuid, uuid, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_pair_pending_portfolios(uuid) FROM PUBLIC, anon, authenticated;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Partner Ops approves / rejects a shared house as a pair
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_other uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  -- Co-support house: the other half is found BEFORE this approval changes statuses.
  SELECT x INTO v_other FROM public._co_support_pair_pending_portfolios(p_portfolio_id) x LIMIT 1;
  IF v_other IS NULL THEN
    RETURN public._approve_pending_portfolio_core(p_portfolio_id, v_caller);
  END IF;
  -- Both halves are debited in this one transaction, or neither is. Always in
  -- the same order, so two reviewers approving the two halves at once cannot
  -- deadlock; the core is idempotent, so the second one finds them approved.
  PERFORM public._approve_pending_portfolio_core(LEAST(p_portfolio_id, v_other), v_caller);
  PERFORM public._approve_pending_portfolio_core(GREATEST(p_portfolio_id, v_other), v_caller);
  RETURN p_portfolio_id;
END;
$function$;

@@REJECT@@

-- Invitation status follows the pair's rows: rejected pair, or a cancelled
-- (approved) pair, closes it; cancelling one approved half cancels the other.
CREATE OR REPLACE FUNCTION public._co_support_house_row_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_closed integer;
BEGIN
  IF NEW.co_support_id IS NULL OR NEW.status <> 'cancelled' OR COALESCE(OLD.status, '') = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' THEN
    -- An approved half was cancelled: the other approved half goes too.
    UPDATE public.partner_supported_houses
       SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
     WHERE co_support_id = NEW.co_support_id AND id <> NEW.id AND status = 'active';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.partner_supported_houses
                  WHERE co_support_id = NEW.co_support_id AND status IN ('pending', 'active')) THEN
    UPDATE public.co_support_invites
       SET status = 'cancelled', closed_at = now(),
           close_reason = CASE WHEN OLD.status = 'pending' THEN 'rejected_by_partner_ops' ELSE 'funding_cancelled' END,
           updated_at = now()
     WHERE id = NEW.co_support_id AND status = 'completed';
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    IF v_closed > 0 AND OLD.status = 'active' THEN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      SELECT s.partner_id, 'co_support_funding_cancelled', 'co_support_invites', NEW.co_support_id::text,
             'Co-supported house cancelled: this partner''s half is due back',
             jsonb_build_object('supported_house_id', s.id, 'commitment_id', s.commitment_id, 'house_id', s.house_id,
                                'amount_paid', s.principal, 'rent_part', s.rent_amount, 'fee_part', s.proxy_fee)
        FROM public.partner_supported_houses s
       WHERE s.co_support_id = NEW.co_support_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_house_row_status() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_co_support_house_row_status ON public.partner_supported_houses;
CREATE TRIGGER trg_co_support_house_row_status
  AFTER UPDATE OF status ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public._co_support_house_row_status();

-- ---------------------------------------------------------------------------
-- 6. What one invitation looks like to the caller (Rent Plan or house)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_invite_json(p_invite_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v public.co_support_invites%ROWTYPE;
  v_role text;
  v_share numeric;
  v_other uuid;
  v_rate numeric;
  v_portfolio uuid;
  v_kind text;
  v_tenant text;
  v_city text;
  v_photo text;
  v_title text;
  v_pending boolean := false;
BEGIN
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_kind := CASE WHEN v.house_id IS NOT NULL THEN 'house' ELSE 'rent_plan' END;

  v_role := CASE WHEN p_viewer = v.lead_partner_id THEN 'lead'
                 WHEN p_viewer IS NOT NULL AND p_viewer = v.invitee_id THEN 'invitee'
                 ELSE 'other' END;
  v_share := CASE WHEN v_role = 'lead' THEN v.lead_share ELSE v.invitee_share END;
  v_other := CASE WHEN v_role = 'lead' THEN COALESCE(v.invitee_id, v.declined_by) ELSE v.lead_partner_id END;
  v_portfolio := CASE WHEN v_role = 'lead' THEN v.lead_portfolio_id
                      WHEN v_role = 'invitee' THEN v.invitee_portfolio_id END;

  -- The viewer's own rate: the stamped one once funded, otherwise today's.
  IF v_role IN ('lead', 'invitee') AND v_portfolio IS NOT NULL THEN
    IF v_kind = 'house' THEN
      SELECT s.monthly_rate INTO v_rate FROM public.partner_supported_houses s
       WHERE s.co_support_id = v.id AND s.partner_id = p_viewer ORDER BY s.created_at DESC LIMIT 1;
    ELSE
      SELECT l.monthly_rate INTO v_rate FROM public.partner_self_funding_lines l
       WHERE l.co_support_id = v.id AND l.partner_id = p_viewer AND l.status <> 'cancelled' LIMIT 1;
    END IF;
  ELSIF p_viewer IS NOT NULL THEN
    BEGIN
      v_rate := public.partner_rate_now(p_viewer);
    EXCEPTION WHEN OTHERS THEN
      v_rate := NULL;
    END;
  END IF;

  IF v_kind = 'house' THEN
    SELECT COALESCE(NULLIF(btrim(hl.title), ''), initcap(replace(COALESCE(hl.house_category, 'house'), '_', ' '))),
           COALESCE(NULLIF(btrim(hl.district), ''), NULLIF(btrim(hl.sub_county), ''), NULLIF(btrim(hl.village), '')),
           hl.image_urls[1]
      INTO v_title, v_city, v_photo
      FROM public.house_listings hl WHERE hl.id = v.house_id;
    v_pending := v.status = 'completed' AND EXISTS (
      SELECT 1 FROM public.partner_supported_houses s WHERE s.co_support_id = v.id AND s.status = 'pending');
  ELSE
    SELECT split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1),
           NULLIF(btrim(rr.request_city), ''),
           rr.house_image_urls[1]
      INTO v_tenant, v_city, v_photo
      FROM public.rent_requests rr
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     WHERE rr.id = v.rent_request_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v.id,
    'kind', v_kind,
    'code', CASE WHEN v_role = 'lead' THEN v.code END,
    'status', public._co_support_status(v.status, v.expires_at, v.declined_at),
    'expires_at', v.expires_at,
    'rent_request_id', v.rent_request_id,
    'house_id', v.house_id,
    'house_title', v_title,
    'tenant_first_name', v_tenant,
    'city', v_city,
    'house_image_url', v_photo,
    'rent_amount', v.rent_amount,
    'plan_amount', v.gross_amount,
    'your_role', v_role,
    'your_share', v_share,
    'partner_share', v.gross_amount - v_share,
    'partner_first_name', public._co_support_first_name(v_other),
    'your_monthly_rent_profit_share', CASE WHEN v_rate IS NULL THEN NULL ELSE round(v_share * v_rate / 100) END,
    'your_portfolio_id', v_portfolio,
    'awaiting_partner_ops', v_pending,
    'accepted_at', v.accepted_at,
    'created_at', v.created_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_invite_json(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Browser functions (house-aware)
-- ---------------------------------------------------------------------------

-- Partner A starts sharing an empty house. Returns the code for the link.
CREATE OR REPLACE FUNCTION public.co_support_create_house(p_house_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inv public.co_support_invites%ROWTYPE;
  v_s jsonb;
BEGIN
  PERFORM public._co_support_require_partner_house(v_uid);
  IF p_house_id IS NULL THEN
    RAISE EXCEPTION 'HOUSE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM public._co_support_lock(p_house_id, v_uid);
  PERFORM public._co_support_expire_stale(p_house_id);

  SELECT * INTO v_inv FROM public.co_support_invites WHERE house_id = p_house_id AND status = 'open';
  IF FOUND THEN
    IF v_inv.lead_partner_id = v_uid THEN
      RETURN public._co_support_invite_json(v_inv.id, v_uid) || jsonb_build_object('idempotent_replay', true);
    END IF;
    RAISE EXCEPTION 'HOUSE_NOT_AVAILABLE: Another partner is already sharing this house. Choose another one.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_s := public._co_support_house_lead_checks(v_uid, p_house_id);

  INSERT INTO public.co_support_invites (
    code, rent_request_id, house_id, lead_partner_id, rent_amount, gross_amount,
    lead_rent, invitee_rent, lead_share, invitee_share, expires_at
  ) VALUES (
    public._co_support_new_code(), NULL, p_house_id, v_uid,
    (v_s->>'rent')::numeric, (v_s->>'gross')::numeric,
    (v_s->>'lead_rent')::numeric, (v_s->>'invitee_rent')::numeric,
    (v_s->>'lead_share')::numeric, (v_s->>'invitee_share')::numeric,
    now() + interval '48 hours'
  ) RETURNING * INTO v_inv;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_invite_created', 'co_support_invites', v_inv.id,
    jsonb_build_object('house_id', p_house_id, 'lead_share', v_inv.lead_share,
                       'invitee_share', v_inv.invitee_share, 'expires_at', v_inv.expires_at));

  RETURN public._co_support_invite_json(v_inv.id, v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_preview(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v public.co_support_invites%ROWTYPE;
  v_out jsonb;
  v_status text;
  v_is_partner boolean;
  v_signed boolean;
  v_float numeric;
  v_rate numeric;
  v_reason text;
  v_switch boolean;
BEGIN
  SELECT * INTO v FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_status := public._co_support_status(v.status, v.expires_at, v.declined_at);
  v_out := public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('found', true,
                              'lead_first_name', public._co_support_first_name(v.lead_partner_id),
                              -- funder-onboarding records this person as the referrer
                              'referrer_id', v.lead_partner_id,
                              'signed_in', v_uid IS NOT NULL);

  IF v_uid IS NULL OR v_uid = v.lead_partner_id OR v_uid = v.invitee_id THEN
    RETURN v_out || jsonb_build_object('can_accept', false);
  END IF;

  v_switch := CASE WHEN v.house_id IS NOT NULL THEN public._pipeline_switch_on('funders_empty_houses')
                   ELSE public._pipeline_switch_on('funder_direct_release') END;
  v_is_partner := public.psm_is_partner(v_uid);
  v_signed := public.funder_has_signed_agreement(v_uid);
  v_float := public.funder_float_available(v_uid);
  BEGIN
    v_rate := public.partner_rate_now(v_uid);
  EXCEPTION WHEN OTHERS THEN
    v_rate := NULL;
  END;

  v_reason := CASE
    WHEN v_status <> 'open' THEN 'invite_' || v_status
    WHEN NOT v_switch THEN 'paused'
    WHEN NOT v_is_partner THEN 'not_a_partner'
    WHEN NOT v_signed THEN 'agreement_required'
    WHEN v_rate IS NULL THEN 'rate_unavailable'
    WHEN v_float < v.invitee_share THEN 'funds_short'
  END;

  RETURN v_out || jsonb_build_object(
    'can_accept', v_reason IS NULL,
    'reason', v_reason,
    'is_partner', v_is_partner,
    'agreement_signed', v_signed,
    'float_available', v_float,
    'float_needed', GREATEST(v.invitee_share - v_float, 0));
END;
$$;

-- Partner B accepts.
--   Rent Plan: both halves paid and the landlord float released now (unchanged).
--   House: both halves become pending portfolios for Partner Ops to approve
--          together; each partner's half is held on their float until then.
CREATE OR REPLACE FUNCTION public.co_support_accept(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_lead_avail numeric;
  v_avail numeric;
  v_problem text;
  v_claimed integer;
  v_lead jsonb;
  v_mine jsonb;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;

  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', NOT v_is_house);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this. Send the link to the partner who will support it with you.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is no longer open.' USING ERRCODE = 'check_violation';
  END IF;
  IF v.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_DECLINED: This invitation was declined. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lead must still be a partner with a signed agreement.
  IF NOT public.psm_is_partner(v.lead_partner_id) OR NOT public.funder_has_signed_agreement(v.lead_partner_id) THEN
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_is_house THEN
    PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
    PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);
  END IF;

  -- Close the invite first: this ends the lead's hold, so their half can be used here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    v_problem := public._co_support_house_problem(v.house_id);
    IF v_problem IS NULL AND (SELECT hl.monthly_rent::numeric FROM public.house_listings hl WHERE hl.id = v.house_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
  ELSE
    v_problem := public._co_support_plan_problem(v.lead_partner_id, v.rent_request_id);
    -- The halves were agreed on this rent. If the rent changed since, nobody pays.
    IF v_problem IS NULL AND (SELECT rr.rent_amount FROM public.rent_requests rr WHERE rr.id = v.rent_request_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
    IF v_problem IS NULL THEN
      INSERT INTO public.partner_self_plan_claims (
        rent_request_id, partner_id, amount, status, idempotency_key, expires_at, confirmed_at
      ) VALUES (
        v.rent_request_id, v.lead_partner_id, v.rent_amount, 'confirmed', 'cosup-' || v.id::text, now(), now()
      )
      ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
      IF v_claimed = 0 THEN
        v_problem := 'plan_held';
      END IF;
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    -- It went elsewhere (or its rent changed). Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent changed after this was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      WHEN v_is_house
                      THEN 'This house was taken before you accepted. Nothing was taken from your wallet.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

  IF v_is_house THEN
    v_lead := public._co_support_open_house_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_house_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');
  ELSE
    v_lead := public._co_support_open_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');

    UPDATE public.partner_self_plan_claims
       SET commitment_id = (v_lead->>'commitment_id')::uuid, updated_at = now()
     WHERE idempotency_key = 'cosup-' || v.id::text
       AND partner_id = v.lead_partner_id
       AND rent_request_id = v.rent_request_id;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v.lead_partner_id,
           self_funding_line_id = (v_lead->>'line_id')::uuid,
           updated_at = now()
     WHERE id = v.rent_request_id;
  END IF;

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  IF v_is_house THEN
    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('portfolio_topup', v_uid, 'co_support_invites', v.id,
              'Two partners co-supported a verified empty house: waiting for Partner Ops',
              jsonb_build_object('house_id', v.house_id, 'amount', v.gross_amount,
                                 'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                                 'lead_portfolio_id', v_lead->>'portfolio_id',
                                 'invitee_portfolio_id', v_mine->>'portfolio_id',
                                 'source', 'self_managed_house'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id,
                         'status', 'pending_ops_approval'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', true, 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  -- Rent Plan: direct release, as in Phase 1.
  PERFORM set_config('app.funder_direct_release', 'on', true);
  PERFORM public._approve_pending_portfolio_core((v_lead->>'portfolio_id')::uuid, v.lead_partner_id);
  PERFORM public._approve_pending_portfolio_core((v_mine->>'portfolio_id')::uuid, v_uid);

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id
       AND a.source = 'partner_self_funding'
       AND a.status IN ('open', 'partially_paid')
       AND a.allocated_amount = v.rent_amount
  ) THEN
    RAISE EXCEPTION 'CO_SUPPORT_RELEASE_FAILED: The landlord float could not be released, so nothing was taken from either wallet. Please try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'co_support_invites', v.id,
            'Two partners co-supported a Rent Plan: rent moved to the agent landlord float',
            jsonb_build_object('rent_request_id', v.rent_request_id, 'rent_amount', v.rent_amount,
                               'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                               'lead_portfolio_id', v_lead->>'portfolio_id',
                               'invitee_portfolio_id', v_mine->>'portfolio_id',
                               'direct_release', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
    jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                       'portfolio_id', v_mine->>'portfolio_id'));

  RETURN public._co_support_invite_json(v.id, v_uid)
      || jsonb_build_object('ok', true, 'landlord_float_released', true,
                            'available_balance', public.funder_float_available(v_uid));
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_decline(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_peek.lead_partner_id);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: To stop sharing, cancel it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF public._co_support_status(v.status, v.expires_at, v.declined_at) <> 'open' THEN
    RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true, 'idempotent_replay', true);
  END IF;

  UPDATE public.co_support_invites
     SET declined_at = now(), declined_by = v_uid, updated_at = now()
   WHERE id = v.id;

  PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_declined', 'co_support_invites', v.id,
    jsonb_build_object('declined_by', v_uid));

  RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_cancel(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status IN ('open', 'expired') THEN
    UPDATE public.co_support_invites
       SET status = 'cancelled', closed_at = now(), close_reason = 'cancelled_by_lead', updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_cancelled', 'co_support_invites', v.id, '{}'::jsonb);
  END IF;

  RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_reinvite(p_invite_id uuid, p_new_link boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_s jsonb;
  v_new public.co_support_invites%ROWTYPE;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id IS DISTINCT FROM v_uid THEN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;
  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed. Start a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Step this invite aside so the checks below see the plan / house as free.
  UPDATE public.co_support_invites
     SET status = 'replaced', closed_at = now(), close_reason = 'reinvited', updated_at = now()
   WHERE id = v.id;

  IF EXISTS (SELECT 1 FROM public.co_support_invites
              WHERE COALESCE(rent_request_id, house_id) = v_peek.target AND status = 'open' AND id <> v.id) THEN
    RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: Another partner is already sharing this.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    v_s := public._co_support_house_lead_checks(v_uid, v.house_id);
  ELSE
    PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
    v_s := public._co_support_lead_checks(v_uid, v.rent_request_id);
  END IF;

  IF p_new_link THEN
    INSERT INTO public.co_support_invites (
      code, rent_request_id, house_id, lead_partner_id, rent_amount, gross_amount,
      lead_rent, invitee_rent, lead_share, invitee_share, expires_at, replaces_id
    ) VALUES (
      public._co_support_new_code(), v.rent_request_id, v.house_id, v_uid,
      (v_s->>'rent')::numeric, (v_s->>'gross')::numeric,
      (v_s->>'lead_rent')::numeric, (v_s->>'invitee_rent')::numeric,
      (v_s->>'lead_share')::numeric, (v_s->>'invitee_share')::numeric,
      now() + interval '48 hours', v.id
    ) RETURNING * INTO v_new;
  ELSE
    UPDATE public.co_support_invites
       SET status = 'open', closed_at = NULL, close_reason = NULL,
           declined_at = NULL, declined_by = NULL,
           rent_amount = (v_s->>'rent')::numeric, gross_amount = (v_s->>'gross')::numeric,
           lead_rent = (v_s->>'lead_rent')::numeric, invitee_rent = (v_s->>'invitee_rent')::numeric,
           lead_share = (v_s->>'lead_share')::numeric, invitee_share = (v_s->>'invitee_share')::numeric,
           expires_at = now() + interval '48 hours', updated_at = now()
     WHERE id = v.id
    RETURNING * INTO v_new;
  END IF;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_reinvited', 'co_support_invites', v_new.id,
    jsonb_build_object('previous_invite_id', v.id, 'new_link', p_new_link, 'expires_at', v_new.expires_at));

  RETURN public._co_support_invite_json(v_new.id, v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_fund_alone(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_need numeric;
  v_avail numeric;
  v_res jsonb;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id IS DISTINCT FROM v_uid THEN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;
  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.co_support_invites
     SET status = 'funded_alone', closed_at = now(), close_reason = 'funded_alone', updated_at = now()
   WHERE id = v.id;

  IF v_is_house THEN
    v_need := public.self_support_gross((SELECT hl.monthly_rent::numeric FROM public.house_listings hl WHERE hl.id = v.house_id));
  ELSE
    v_need := public.self_support_gross(v.rent_amount);
  END IF;
  v_avail := public.funder_support_capacity(v_uid);
  IF v_avail < v_need THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: The full amount is UGX %. You have UGX % of operational float. Add float to your wallet, then try again.',
      public._co_support_fmt(v_need), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    -- The one-partner house path (waits for Partner Ops, as always).
    v_res := public.partner_support_houses(ARRAY[v.house_id], 1, NULL, NULL);
  ELSE
    v_res := public.funder_support_tenant_direct(ARRAY[v.rent_request_id], NULL, 1);
  END IF;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_funded_alone', 'co_support_invites', v.id,
    jsonb_build_object('amount', v_need, 'result', v_res));

  RETURN v_res || jsonb_build_object('co_support_id', v.id, 'ok', true);
END;
$$;

-- Partner Ops: cancel the funding of a co-supported Rent Plan or house (both halves).
CREATE OR REPLACE FUNCTION public.co_support_staff_cancel(p_invite_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v public.co_support_invites%ROWTYPE;
  v_after text;
  v_reason text;
  v_refunds jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF length(COALESCE(btrim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'completed' THEN
    RAISE EXCEPTION 'NOT_FUNDED: This co-support invitation has no funding to cancel (status %).', v.status
      USING ERRCODE = 'check_violation';
  END IF;
  v_reason := 'staff_cancelled: ' || btrim(p_reason);

  IF v.house_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.partner_supported_houses WHERE co_support_id = v.id AND status = 'pending') THEN
      RAISE EXCEPTION 'PENDING_APPROVAL: This shared house is still waiting for approval. Reject it from the approval queue instead (both halves are rejected together).'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('partner_id', s.partner_id,
                                        'partner_first_name', public._co_support_first_name(s.partner_id),
                                        'amount', s.principal, 'commitment_id', s.commitment_id)
                     ORDER BY (s.partner_id = v.lead_partner_id) DESC)
      INTO v_refunds
      FROM public.partner_supported_houses s WHERE s.co_support_id = v.id AND s.status = 'active';
    UPDATE public.partner_supported_houses
       SET status = 'cancelled', cancelled_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('end_reason', v_reason),
           updated_at = now()
     WHERE co_support_id = v.id AND status = 'active';
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v.rent_request_id AND a.source = 'partner_self_funding'
         AND COALESCE(a.paid_out_amount, 0) > 0
    ) THEN
      RAISE EXCEPTION 'LANDLORD_ALREADY_PAID: The landlord has already been paid from this float, so the funding cannot be cancelled here.'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('partner_id', l.partner_id,
                                        'partner_first_name', public._co_support_first_name(l.partner_id),
                                        'amount', l.principal, 'commitment_id', l.commitment_id)
                     ORDER BY (l.partner_id = v.lead_partner_id) DESC)
      INTO v_refunds
      FROM public.partner_self_funding_lines l WHERE l.co_support_id = v.id;
    -- Both halves in one statement; the line trigger releases the plan once.
    UPDATE public.partner_self_funding_lines
       SET status = 'cancelled', end_reason = v_reason, updated_at = now()
     WHERE co_support_id = v.id AND status <> 'cancelled';
  END IF;

  SELECT status INTO v_after FROM public.co_support_invites WHERE id = v.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'co_support_staff_cancel', 'co_support_invites', v.id::text, btrim(p_reason),
          jsonb_build_object('rent_request_id', v.rent_request_id, 'house_id', v.house_id,
                             'lead_partner_id', v.lead_partner_id, 'invitee_id', v.invitee_id));

  RETURN jsonb_build_object(
    'success', v_after = 'cancelled',
    'kind', CASE WHEN v.house_id IS NOT NULL THEN 'house' ELSE 'rent_plan' END,
    'rent_request_id', v.rent_request_id,
    'house_id', v.house_id,
    'plan_released', v_after = 'cancelled',
    'refunds_due', v_refunds,
    'note', 'Both halves are cancelled and it is back on the list. Refund each partner their half through the usual finance step.');
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Health check, now for houses too. Expected result: no rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.co_support_integrity_check()
RETURNS TABLE (invite_id uuid, rent_request_id uuid, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH done AS (
    SELECT i.* FROM public.co_support_invites i WHERE i.status = 'completed' AND i.rent_request_id IS NOT NULL
  ), lines AS (
    SELECT d.id, count(l.id) AS n,
           COALESCE(sum(l.rent_amount), 0) AS rent,
           COALESCE(sum(l.principal), 0) AS principal,
           count(l.id) FILTER (WHERE l.status NOT IN ('active', 'completed')) AS not_live
      FROM done d
      LEFT JOIN public.partner_self_funding_lines l ON l.co_support_id = d.id AND l.status <> 'cancelled'
     GROUP BY d.id
  ), hdone AS (
    SELECT i.* FROM public.co_support_invites i WHERE i.status = 'completed' AND i.house_id IS NOT NULL
  ), hrows AS (
    SELECT d.id, count(s.id) AS n,
           COALESCE(sum(s.rent_amount), 0) AS rent,
           COALESCE(sum(s.principal), 0) AS principal,
           count(s.id) FILTER (WHERE s.status = 'pending') AS pending,
           count(s.id) FILTER (WHERE s.status = 'active') AS active
      FROM hdone d
      LEFT JOIN public.partner_supported_houses s ON s.co_support_id = d.id AND s.status IN ('pending', 'active')
     GROUP BY d.id
  )
  -- Rent Plans (Phase 1)
  SELECT d.id, d.rent_request_id, 'expected 2 funding lines, found ' || l.n
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n <> 2
  UNION ALL
  SELECT d.id, d.rent_request_id, 'line rent ' || l.rent || ' <> plan rent ' || d.rent_amount
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n = 2 AND l.rent <> d.rent_amount
  UNION ALL
  SELECT d.id, d.rent_request_id, 'line principal ' || l.principal || ' <> agreed ' || d.gross_amount
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n = 2 AND l.principal <> d.gross_amount
  UNION ALL
  SELECT d.id, d.rent_request_id, l.not_live || ' funding line(s) not earning'
    FROM done d JOIN lines l ON l.id = d.id WHERE l.not_live > 0
  UNION ALL
  SELECT d.id, d.rent_request_id, 'no landlord float allocation for the full rent'
    FROM done d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.agent_landlord_float_allocations a
      WHERE a.rent_request_id = d.rent_request_id AND a.source = 'partner_self_funding'
        AND a.status NOT IN ('cancelled', 'reversed') AND a.allocated_amount = d.rent_amount)
  UNION ALL
  SELECT d.id, d.rent_request_id, 'a half was never debited'
    FROM done d
   WHERE (SELECT count(*) FROM public.general_ledger g
           WHERE g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
             AND g.idempotency_key IN ('psm-commit-' || d.lead_commitment_id::text,
                                       'psm-commit-' || d.invitee_commitment_id::text)) <> 2
  UNION ALL
  SELECT l.co_support_id, l.rent_request_id, 'funding line on an invite that is not completed'
    FROM public.partner_self_funding_lines l
    JOIN public.co_support_invites i ON i.id = l.co_support_id
   WHERE l.status <> 'cancelled' AND i.status <> 'completed'
  -- Houses (Phase 4); rent_request_id column carries the house id here
  UNION ALL
  SELECT d.id, d.house_id, 'house: expected 2 supported-house rows, found ' || h.n
    FROM hdone d JOIN hrows h ON h.id = d.id WHERE h.n <> 2
  UNION ALL
  SELECT d.id, d.house_id, 'house: one half approved, the other still pending'
    FROM hdone d JOIN hrows h ON h.id = d.id WHERE h.pending > 0 AND h.active > 0
  UNION ALL
  SELECT d.id, d.house_id, 'house: rent ' || h.rent || ' <> agreed ' || d.rent_amount
    FROM hdone d JOIN hrows h ON h.id = d.id WHERE h.n = 2 AND h.rent <> d.rent_amount
  UNION ALL
  SELECT d.id, d.house_id, 'house: principal ' || h.principal || ' <> agreed ' || d.gross_amount
    FROM hdone d JOIN hrows h ON h.id = d.id WHERE h.n = 2 AND h.principal <> d.gross_amount
  UNION ALL
  SELECT d.id, d.house_id, 'house: approved but a half was never debited'
    FROM hdone d JOIN hrows h ON h.id = d.id
   WHERE h.active = 2
     AND (SELECT count(*) FROM public.general_ledger g
           WHERE g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
             AND g.idempotency_key IN ('psh-commit-' || d.lead_commitment_id::text,
                                       'psh-commit-' || d.invitee_commitment_id::text)) <> 2
  UNION ALL
  SELECT s.co_support_id, s.house_id, 'house: supported row on an invite that is not completed'
    FROM public.partner_supported_houses s
    JOIN public.co_support_invites i ON i.id = s.co_support_id
   WHERE s.status IN ('pending', 'active') AND i.status <> 'completed';
$$;
REVOKE ALL ON FUNCTION public.co_support_integrity_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.co_support_integrity_check() TO service_role;

-- Partner Ops: every shared Rent Plan / house that has funding (or waits for
-- approval), newest first, so a pair can be found and cancelled together.
CREATE OR REPLACE FUNCTION public.co_support_staff_list(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x->>'accepted_at') DESC NULLS LAST)
      FROM (
        SELECT jsonb_build_object(
                 'invite_id', i.id,
                 'kind', CASE WHEN i.house_id IS NOT NULL THEN 'house' ELSE 'rent_plan' END,
                 'rent_request_id', i.rent_request_id,
                 'house_id', i.house_id,
                 'title', CASE WHEN i.house_id IS NOT NULL
                               THEN COALESCE(NULLIF(btrim(hl.title), ''), 'Empty house')
                               ELSE 'Rent Plan for ' || split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1) END,
                 'place', COALESCE(NULLIF(btrim(hl.district), ''), NULLIF(btrim(rr.request_city), '')),
                 'rent_amount', i.rent_amount,
                 'plan_amount', i.gross_amount,
                 'status', CASE
                             WHEN i.house_id IS NOT NULL AND EXISTS (
                               SELECT 1 FROM public.partner_supported_houses s
                                WHERE s.co_support_id = i.id AND s.status = 'pending') THEN 'awaiting_approval'
                             ELSE 'funded' END,
                 'landlord_paid_out', COALESCE((
                   SELECT sum(a.paid_out_amount) FROM public.agent_landlord_float_allocations a
                    WHERE a.rent_request_id = i.rent_request_id AND a.source = 'partner_self_funding'
                      AND a.status NOT IN ('cancelled', 'reversed')), 0),
                 'partners', jsonb_build_array(
                   jsonb_build_object('role', 'lead', 'partner_id', i.lead_partner_id,
                                      'name', lp.full_name, 'amount', i.lead_share, 'portfolio_id', i.lead_portfolio_id),
                   jsonb_build_object('role', 'invitee', 'partner_id', i.invitee_id,
                                      'name', ip.full_name, 'amount', i.invitee_share, 'portfolio_id', i.invitee_portfolio_id)),
                 'accepted_at', i.accepted_at) AS x
          FROM public.co_support_invites i
          LEFT JOIN public.house_listings hl ON hl.id = i.house_id
          LEFT JOIN public.rent_requests rr ON rr.id = i.rent_request_id
          LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
          LEFT JOIN public.profiles lp ON lp.id = i.lead_partner_id
          LEFT JOIN public.profiles ip ON ip.id = i.invitee_id
         WHERE i.status = 'completed'
         ORDER BY i.accepted_at DESC NULLS LAST
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
      ) q
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants for the new browser functions
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.co_support_create_house(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_support_create_house(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.co_support_staff_list(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_support_staff_list(integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.co_support_create_house(uuid) IS
  'Co-support: the caller (a partner with a signed agreement and their half as operational float) starts sharing one verified empty house 50/50. Holds the house and the caller''s half for 48 hours. Returns the link code.';

-- ---------------------------------------------------------------------------
-- 10. Last on purpose (blocks house_listings writes only until commit)
-- ---------------------------------------------------------------------------
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_invites_house_id_fkey;
ALTER TABLE public.co_support_invites
  ADD CONSTRAINT co_support_invites_house_id_fkey FOREIGN KEY (house_id) REFERENCES public.house_listings(id);
