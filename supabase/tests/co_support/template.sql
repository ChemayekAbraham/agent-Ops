-- Co-support, Phase 1: two partners share one Rent Plan 50/50.
--
-- How it works, in plain words:
--   1. Partner A picks a Rent Plan and calls co_support_create. A gets a code
--      for a link. The plan leaves everyone else's list for 48 hours, and A's
--      half is held on A's operational float (funder_pending_hold) so A cannot
--      spend it elsewhere.
--   2. Partner B opens the link. co_support_preview shows who is asking, the
--      plan and B's half (anyone with the code may read it; signed-in callers
--      also see whether they can accept and why not).
--   3. B calls co_support_accept. B must be a partner, have signed the
--      partnership agreement, and hold their half as operational float. No
--      promise-to-deposit: the money must already be in the wallet.
--   4. In that one transaction both halves become their own commitment and
--      their own portfolio (principal = that partner's half, Rent Profit Share
--      at that partner's own rate), both wallets are debited through
--      _approve_pending_portfolio_core (direct release), and the landlord float
--      is released ONCE, for the full rent, only after both debits exist
--      (_co_support_disburse_landlord_float). If anything fails, everything
--      rolls back and no money moves.
--   5. Until B accepts, A can cancel (co_support_cancel), re-invite the same
--      person or a new one (co_support_reinvite), or pay the full amount alone
--      (co_support_fund_alone). B can decline (co_support_decline); the plan
--      stays held for A until the 48 hours run out.
--
-- Halves are exact: lead = ceil(x/2), invitee = x - lead, for both the rent
-- and the amount partners pay (rent + the 2% fee while that switch is on).
-- Each half must be at least UGX 50,000, so only plans of UGX 100,000 or more
-- can be shared. Rent Plans only; houses come later.
--
-- Co-support needs pipeline switch funder_direct_release ON (live since
-- 2026-11-11). With it OFF, create and accept refuse, so no half ever waits in
-- the Partner Ops queue on its own.
--
-- Changed live objects (bodies taken from the live database, then edited):
--   psm_disburse_landlord_float        + co-support branch at the top
--   psm_activate_line_on_disbursement  activates every idle line, not just one
--                                      (two lines made the old RETURNING INTO
--                                      fail, and the error was swallowed)
--   funder_pending_hold                + the lead's open invite halves
--   v_partner_self_fundable_plans      + hide plans with an open invite
--   ux_psfl_active_plan                one line per plan, except co-support
--                                      (one line per partner per plan)

-- Function bodies below contain non-ASCII text (an em dash in a live comment);
-- Windows psql would otherwise read this file as WIN1252 and change it.
SET client_encoding = 'UTF8';
-- Fail fast instead of queueing behind a long transaction on rent_requests or
-- partner_self_funding_lines (the FK and index steps below briefly lock them).
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Invites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.co_support_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  rent_request_id uuid NOT NULL,  -- FK to rent_requests added as the LAST step (see end of file)
  lead_partner_id uuid NOT NULL,
  invitee_id uuid,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','cancelled','expired','replaced','funded_alone','plan_unavailable')),
  rent_amount numeric NOT NULL CHECK (rent_amount > 0),
  gross_amount numeric NOT NULL,
  lead_rent numeric NOT NULL,
  invitee_rent numeric NOT NULL,
  lead_share numeric NOT NULL,
  invitee_share numeric NOT NULL,
  expires_at timestamptz NOT NULL,
  declined_at timestamptz,
  declined_by uuid,
  replaces_id uuid REFERENCES public.co_support_invites(id),
  lead_commitment_id uuid,
  invitee_commitment_id uuid,
  lead_portfolio_id uuid,
  invitee_portfolio_id uuid,
  accepted_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT co_support_halves_add_up CHECK (
    lead_rent + invitee_rent = rent_amount
    AND lead_share + invitee_share = gross_amount
    AND gross_amount >= rent_amount
    AND invitee_rent >= 50000
    AND lead_share >= lead_rent AND invitee_share >= invitee_rent)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_co_support_one_open_per_plan
  ON public.co_support_invites (rent_request_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_co_support_lead ON public.co_support_invites (lead_partner_id, status);
CREATE INDEX IF NOT EXISTS idx_co_support_invitee ON public.co_support_invites (invitee_id) WHERE invitee_id IS NOT NULL;

ALTER TABLE public.co_support_invites ENABLE ROW LEVEL SECURITY;
-- Browsers never read or write this table directly: every screen goes through
-- the functions below. service_role keeps full access for support work.
REVOKE ALL ON public.co_support_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.co_support_invites TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.co_support_invites;
CREATE POLICY mfa_required_for_staff ON public.co_support_invites
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

COMMENT ON TABLE public.co_support_invites IS
  'Co-support: one 48-hour invitation for two partners to share one Rent Plan 50/50. Written only by the co_support_* functions.';

-- ---------------------------------------------------------------------------
-- 2. Funding lines: one line per plan, except a co-supported plan, which has
--    one line per partner.
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_self_funding_lines
  ADD COLUMN IF NOT EXISTS co_support_id uuid REFERENCES public.co_support_invites(id);

DROP INDEX IF EXISTS public.ux_psfl_active_plan;
CREATE UNIQUE INDEX ux_psfl_active_plan
  ON public.partner_self_funding_lines (rent_request_id)
  WHERE status <> 'cancelled' AND co_support_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_psfl_active_plan_co_support
  ON public.partner_self_funding_lines (rent_request_id, partner_id)
  WHERE status <> 'cancelled' AND co_support_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psfl_co_support
  ON public.partner_self_funding_lines (co_support_id) WHERE co_support_id IS NOT NULL;

-- A plan is funded either by one partner or by one co-support pair, never both.
CREATE OR REPLACE FUNCTION public._psfl_no_mixed_funding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_self_funding_lines l
     WHERE l.rent_request_id = NEW.rent_request_id
       AND l.id <> NEW.id
       AND l.status <> 'cancelled'
       AND (l.co_support_id IS DISTINCT FROM NEW.co_support_id)
  ) THEN
    RAISE EXCEPTION 'PLAN_ALREADY_FUNDED: this Rent Plan already has a different funding line'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._psfl_no_mixed_funding() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_psfl_no_mixed_funding ON public.partner_self_funding_lines;
CREATE TRIGGER trg_psfl_no_mixed_funding
  BEFORE INSERT OR UPDATE OF rent_request_id, co_support_id, status ON public.partner_self_funding_lines
  FOR EACH ROW EXECUTE FUNCTION public._psfl_no_mixed_funding();

-- ---------------------------------------------------------------------------
-- 3. Small helpers (closed to browsers)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_split(p_rent numeric)
RETURNS TABLE (lead_rent numeric, invitee_rent numeric, gross numeric, lead_share numeric, invitee_share numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ceil(p_rent / 2),
         p_rent - ceil(p_rent / 2),
         g.gross,
         ceil(g.gross / 2),
         g.gross - ceil(g.gross / 2)
    FROM (SELECT public.self_support_gross(p_rent) AS gross) g;
$$;

CREATE OR REPLACE FUNCTION public._co_support_first_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NULLIF(initcap(split_part(btrim(COALESCE(p.full_name, '')), ' ', 1)), '')
    FROM public.profiles p WHERE p.id = p_user;
$$;

CREATE OR REPLACE FUNCTION public._co_support_status(p_status text, p_expires_at timestamptz, p_declined_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
           WHEN p_status = 'open' AND p_expires_at <= now() THEN 'expired'
           WHEN p_status = 'open' AND p_declined_at IS NOT NULL THEN 'declined'
           ELSE p_status
         END;
$$;

CREATE OR REPLACE FUNCTION public._co_support_fmt(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT to_char(round(COALESCE(p_amount, 0)), 'FM999,999,999,990');
$$;

CREATE OR REPLACE FUNCTION public._co_support_new_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.co_support_invites WHERE code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public._co_support_expire_stale(p_rent_request_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.co_support_invites
     SET status = 'expired', closed_at = now(), close_reason = 'expired', updated_at = now()
   WHERE status = 'open'
     AND expires_at <= now()
     AND (p_rent_request_id IS NULL OR rent_request_id = p_rent_request_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- NULL when the lead may hold this plan; otherwise a reason code.
-- Call only while no open invite holds the plan (the view hides those).
CREATE OR REPLACE FUNCTION public._co_support_plan_problem(p_partner uuid, p_rent_request_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.v_partner_self_fundable_plans p
     WHERE p.rent_request_id = p_rent_request_id
       AND (p.held_by IS NULL OR p.held_by = p_partner)
  ) THEN
    RETURN 'plan_not_available';
  END IF;
  IF public.psm_plan_booked_for_other(p_rent_request_id, p_partner) THEN
    RETURN 'plan_booked_by_other';
  END IF;
  RETURN NULL;
END;
$$;

-- One invitation as the caller may see it. Never returns the other partner's
-- rate or Rent Profit Share.
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
  v_rr record;
BEGIN
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_role := CASE WHEN p_viewer = v.lead_partner_id THEN 'lead'
                 WHEN p_viewer IS NOT NULL AND p_viewer = v.invitee_id THEN 'invitee'
                 ELSE 'other' END;
  v_share := CASE WHEN v_role = 'lead' THEN v.lead_share ELSE v.invitee_share END;
  v_other := CASE WHEN v_role = 'lead' THEN COALESCE(v.invitee_id, v.declined_by) ELSE v.lead_partner_id END;
  v_portfolio := CASE WHEN v_role = 'lead' THEN v.lead_portfolio_id
                      WHEN v_role = 'invitee' THEN v.invitee_portfolio_id END;

  -- The viewer's own rate: the stamped one once funded, otherwise today's.
  IF v_role IN ('lead', 'invitee') AND v_portfolio IS NOT NULL THEN
    SELECT l.monthly_rate INTO v_rate
      FROM public.partner_self_funding_lines l
     WHERE l.co_support_id = v.id AND l.partner_id = p_viewer AND l.status <> 'cancelled'
     LIMIT 1;
  ELSIF p_viewer IS NOT NULL THEN
    BEGIN
      v_rate := public.partner_rate_now(p_viewer);
    EXCEPTION WHEN OTHERS THEN
      v_rate := NULL;
    END;
  END IF;

  SELECT split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1) AS tenant_first_name,
         NULLIF(btrim(rr.request_city), '') AS city,
         rr.house_image_urls[1] AS house_image_url
    INTO v_rr
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
   WHERE rr.id = v.rent_request_id;

  RETURN jsonb_build_object(
    'id', v.id,
    'code', CASE WHEN v_role = 'lead' THEN v.code END,
    'status', public._co_support_status(v.status, v.expires_at, v.declined_at),
    'expires_at', v.expires_at,
    'rent_request_id', v.rent_request_id,
    'tenant_first_name', v_rr.tenant_first_name,
    'city', v_rr.city,
    'house_image_url', v_rr.house_image_url,
    'rent_amount', v.rent_amount,
    'plan_amount', v.gross_amount,
    'your_role', v_role,
    'your_share', v_share,
    'partner_share', v.gross_amount - v_share,
    'partner_first_name', public._co_support_first_name(v_other),
    'your_monthly_rent_profit_share', CASE WHEN v_rate IS NULL THEN NULL ELSE round(v_share * v_rate / 100) END,
    'your_portfolio_id', v_portfolio,
    'accepted_at', v.accepted_at,
    'created_at', v.created_at
  );
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public._co_support_split(numeric) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_first_name(uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_status(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_fmt(numeric) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_new_code() FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_expire_stale(uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_plan_problem(uuid, uuid) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public._co_support_invite_json(uuid, uuid) FROM PUBLIC, anon, authenticated;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The lead's half is held while the invite is open.
--    (live body + the co-support term)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.funder_pending_hold(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(f.amount), 0)::numeric
  FROM public.funder_pending_portfolios f
  WHERE f.funder_id = p_user_id
    AND f.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || f.portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = f.portfolio_id)
           OR (f.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = f.commitment_id))
         )
    ))
  -- Co-support: the lead's half stays held while their invitation is open.
  + COALESCE((
      SELECT SUM(i.lead_share)
        FROM public.co_support_invites i
       WHERE i.lead_partner_id = p_user_id
         AND i.status = 'open'
         AND i.expires_at > now()), 0);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. A plan with an open invite is not on anyone's list.
--    (live view + the last condition)
-- ---------------------------------------------------------------------------
@@VIEW@@

-- ---------------------------------------------------------------------------
-- 6. Activate every idle line when the plan is funded (live body, loop added).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_activate_line_on_disbursement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_line public.partner_self_funding_lines%ROWTYPE; v_live timestamptz;
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    v_live := COALESCE(NEW.disbursed_at, NEW.funded_at);
    IF v_live IS NULL THEN RETURN NEW; END IF;

    -- A co-supported plan has one line per partner; activate each of them.
    FOR v_line IN
      UPDATE public.partner_self_funding_lines
         SET status='active', live_at=v_live,
             term_end_at = v_live + (term_months || ' months')::interval,
             updated_at = now()
       WHERE rent_request_id = NEW.id AND status='idle'
      RETURNING *
    LOOP
      UPDATE public.partner_self_commitments
         SET payout_anchor_at = v_live,
             payout_day = EXTRACT(DAY FROM v_live)::smallint,
             next_payout_at = v_live + interval '1 month',
             term_end_at = v_live + (term_months || ' months')::interval,
             updated_at = now()
       WHERE id = v_line.commitment_id AND payout_anchor_at IS NULL;

      PERFORM public.psm_audit(NULL, v_line.partner_id, 'line_activated',
        'partner_self_funding_lines', v_line.id,
        jsonb_build_object('rent_request_id', NEW.id, 'live_at', v_live,
                           'principal', v_line.principal, 'linked_party', 'self_managed_partner'));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Release the landlord float once, for the full rent, after both halves
--    are paid. Called from psm_disburse_landlord_float for either half.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_disburse_landlord_float(p_commitment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_co uuid;
  v_inv public.co_support_invites%ROWTYPE;
  v_lines integer;
  v_paid integer;
  v_rent numeric;
  v_lead_line uuid;
  v_rr record;
  v_line record;
  v_alloc uuid;
  v_ref text;
  v_landlord_name text;
  v_pool_entry uuid;
  v_pool_drawn numeric := 0;
  v_treasury jsonb;
  v_notices integer := 0;
BEGIN
  SELECT l.co_support_id INTO v_co
    FROM public.partner_self_funding_lines l
   WHERE l.commitment_id = p_commitment_id AND l.co_support_id IS NOT NULL
   LIMIT 1;
  IF v_co IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'not_co_support');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('co-support-float-' || v_co::text));
  SELECT * INTO v_inv FROM public.co_support_invites WHERE id = v_co;

  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.general_ledger g
            WHERE g.idempotency_key = 'psm-commit-' || l.commitment_id::text
              AND g.ledger_scope = 'wallet'
              AND g.direction = 'cash_out')),
         COALESCE(SUM(COALESCE(l.rent_amount, l.principal)), 0)
    INTO v_lines, v_paid, v_rent
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.status <> 'cancelled';

  -- Wait for the other half. The second half's approval releases the float.
  IF v_lines <> 2 OR v_paid < 2 THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'co_support_float_waiting',
      'co_support_invites', v_co,
      jsonb_build_object('lines', v_lines, 'paid', v_paid, 'commitment_id', p_commitment_id));
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'co_support_waiting_for_other_half',
                              'lines', v_lines, 'paid', v_paid);
  END IF;

  SELECT l.id INTO v_lead_line
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.partner_id = v_inv.lead_partner_id AND l.status <> 'cancelled'
   LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'psm-float-' || v_lead_line::text) THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'already_released');
  END IF;

  SELECT rr.id, rr.tenant_id, rr.landlord_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         ld.name AS landlord_name,
         COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
    INTO v_rr
    FROM public.rent_requests rr
    LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
   WHERE rr.id = v_inv.rent_request_id;

  -- Both partners have paid, so never leave the money without a landlord float:
  -- refuse, and the caller's transaction (both debits) rolls back.
  IF v_rr.agent_id IS NULL THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v_rr.id AND a.status IN ('open', 'partially_paid')
  ) THEN
    RAISE EXCEPTION 'PLAN_ALREADY_FUNDED: This Rent Plan already has landlord float.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_landlord_name := COALESCE(v_rr.landlord_name, 'Unknown Landlord');
  v_ref := 'PSC-' || upper(substr(replace(v_co::text, '-', ''), 1, 8));

  -- One allocation for the full rent: the agent pays the landlord once.
  INSERT INTO public.agent_landlord_float_allocations (
    agent_id, tenant_id, rent_request_id, landlord_id,
    landlord_name, landlord_phone, allocated_amount, source,
    funded_by_partner_id, funding_reference
  ) VALUES (
    v_rr.agent_id, v_rr.tenant_id, v_rr.id, v_rr.landlord_id,
    v_landlord_name, v_rr.landlord_phone, v_rent, 'partner_self_funding',
    v_inv.lead_partner_id, v_ref
  )
  RETURNING id INTO v_alloc;

  -- One ledger pair per half, each under its own line (same key shape as a
  -- single-partner release: psm-float-<line>).
  FOR v_line IN
    SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS amount
      FROM public.partner_self_funding_lines l
     WHERE l.co_support_id = v_co AND l.status <> 'cancelled'
     ORDER BY (l.partner_id = v_inv.lead_partner_id) DESC, l.created_at
  LOOP
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.amount,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name || ' (co-support half)'
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.amount,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Landlord float credited (partner-funded, co-support half) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.id::text
    );

    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_rr.id, v_line.amount, 'self_support', v_alloc, v_pool_entry,
        'co_support_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;
  END LOOP;

  INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
  VALUES (v_rr.agent_id, v_rent, auth.uid(), v_rr.id,
          'Partner-funded landlord float (co-support) for ' || v_landlord_name)
  ON CONFLICT DO NOTHING;

  UPDATE public.rent_requests
     SET status = 'funded',
         funded_at = COALESCE(funded_at, now()),
         self_funding_partner_id = COALESCE(self_funding_partner_id, v_inv.lead_partner_id),
         self_funding_line_id = COALESCE(self_funding_line_id, v_lead_line),
         updated_at = now()
   WHERE id = v_rr.id
     AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                    'tenant_ops_approved','landlord_ops_approved','cfo_approved');

  v_treasury := public.recognise_funding_treasury(v_rr.id);

  -- Agent and landlord notices: one each, for the full rent, under the lead.
  INSERT INTO public.partner_float_agent_notices (
    commitment_id, topup_id, partner_id, agent_id, landlord_id,
    landlord_name, amount, tenant_count, rent_request_ids
  ) VALUES (
    v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, v_rr.landlord_id,
    COALESCE(v_rr.landlord_name, 'the landlord'), v_rent, 1, ARRAY[v_rr.id]
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_notices = ROW_COUNT;

  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, pa.full_name, v_rr.landlord_id,
           COALESCE(v_rr.landlord_name, 'the landlord'), ld.phone, v_rent, 1,
           CASE WHEN btrim(COALESCE(pt.full_name, '')) <> ''
                THEN ARRAY[initcap(split_part(btrim(pt.full_name), ' ', 1))]
                ELSE '{}'::text[] END,
           ARRAY[v_rr.id]
      FROM (SELECT 1) one
      LEFT JOIN public.profiles pa ON pa.id = v_rr.agent_id
      LEFT JOIN public.profiles pt ON pt.id = v_rr.tenant_id
      LEFT JOIN public.landlords ld ON ld.id = v_rr.landlord_id
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_sms_queue_failed',
      'co_support_invites', v_co, jsonb_build_object('error', SQLERRM));
  END;

  IF COALESCE(current_setting('app.funder_direct_release', true), '') = 'on' THEN
    BEGIN
      PERFORM public._funder_direct_release_note(v_rr.id, v_rr.agent_id, v_alloc);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funder direct release flag failed for co-supported plan %: %', v_rr.id, SQLERRM;
    END;
  END IF;

  PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_float_disbursed',
    'co_support_invites', v_co,
    jsonb_build_object('funded_lines', 2, 'total_amount', v_rent, 'allocation_id', v_alloc,
                       'notices_queued', v_notices, 'treasury', v_treasury,
                       'landlord_pool_drawn', v_pool_drawn, 'co_support', true));

  RETURN jsonb_build_object('funded', 1, 'skipped', 0, 'total_amount', v_rent,
                            'notices_queued', v_notices,
                            'treasury_recognised', CASE WHEN (v_treasury->>'status') = 'recognised' THEN 1 ELSE 0 END,
                            'landlord_pool_drawn', v_pool_drawn,
                            'co_support_id', v_co, 'allocation_id', v_alloc);
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_disburse_landlord_float(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. psm_disburse_landlord_float: live body + the co-support branch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$@@DISBURSE_BODY@@$function$;

-- ---------------------------------------------------------------------------
-- 9. One half: its own commitment, line, portfolio and pending row
--    (the same rows psm_confirm_commitment_for writes for one partner).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_open_half(
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
  v_line uuid;
  v_agent uuid;
  v_code text;
  v_portfolio uuid;
  v_stored numeric;
  v_rr uuid;
BEGIN
  SELECT rent_request_id INTO v_rr FROM public.co_support_invites WHERE id = p_invite_id;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id
  ) VALUES (
    p_partner, p_gross, v_term, v_rate, 1, v_key, 'pending_ops_approval', NULL
  ) RETURNING id INTO v_commitment;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months, co_support_id
  ) VALUES (
    v_commitment, p_partner, v_rr, p_gross, p_rent, p_gross - p_rent,
    CASE WHEN p_gross > p_rent THEN 'pending' END,
    v_rate, v_term, p_invite_id
  ) RETURNING id INTO v_line;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

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
    portfolio_id, funder_id, amount, source, commitment_id, term_months, promissory_note_id
  ) VALUES (v_portfolio, p_partner, p_gross, 'self_managed', v_commitment, v_term, NULL);

  PERFORM public.psm_audit(COALESCE(auth.uid(), p_partner), p_partner, 'co_support_half_committed',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('co_support_id', p_invite_id, 'role', p_role, 'amount', p_gross,
                       'rent_amount', p_rent, 'proxy_fee', p_gross - p_rent,
                       'portfolio_id', v_portfolio, 'term_months', v_term));

  RETURN jsonb_build_object('commitment_id', v_commitment, 'portfolio_id', v_portfolio,
                            'line_id', v_line, 'rate', v_rate);
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_open_half(uuid, uuid, numeric, numeric, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Shared checks for create and re-invite. Caller holds the plan lock and
--     the lead's psm-commit lock, and no open invite holds the plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._co_support_lead_checks(p_lead uuid, p_rent_request_id uuid)
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
  -- My own short cart hold on this plan gives way to the 48-hour invite.
  UPDATE public.partner_self_plan_claims
     SET status = 'released', closed_at = now(), updated_at = now()
   WHERE partner_id = p_lead AND status = 'held' AND rent_request_id = p_rent_request_id;

  IF public._co_support_plan_problem(p_lead, p_rent_request_id) IS NOT NULL THEN
    RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: This Rent Plan is no longer available. Choose another one.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT rent_amount INTO v_rent FROM public.rent_requests WHERE id = p_rent_request_id;
  SELECT * INTO s FROM public._co_support_split(v_rent);

  IF s.invitee_rent < 50000 THEN
    RAISE EXCEPTION 'CO_SUPPORT_PLAN_TOO_SMALL: Each half must be at least UGX 50,000, so only Rent Plans of UGX 100,000 or more can be shared.'
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
REVOKE ALL ON FUNCTION public._co_support_lead_checks(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._co_support_require_partner(p_uid uuid)
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
  IF NOT public._pipeline_switch_on('funder_direct_release') THEN
    RAISE EXCEPTION 'CO_SUPPORT_UNAVAILABLE: Supporting a Rent Plan with another partner is paused right now.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.funder_has_signed_agreement(p_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED: Sign your partnership agreement first.'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_require_partner(uuid) FROM PUBLIC, anon, authenticated;

-- Locks in one order everywhere: plan, then partners by id, then the row.
CREATE OR REPLACE FUNCTION public._co_support_lock(p_rent_request_id uuid, p_a uuid, p_b uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('co-support-plan-' || p_rent_request_id::text));
  IF p_b IS NULL OR p_a = p_b THEN
    PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_a::text));
  ELSIF p_a::text < p_b::text THEN
    PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_a::text));
    PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_b::text));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_b::text));
    PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_a::text));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._co_support_lock(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Browser functions
-- ---------------------------------------------------------------------------

-- Partner A starts sharing a plan. Returns the code for the link.
CREATE OR REPLACE FUNCTION public.co_support_create(p_rent_request_id uuid)
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
  PERFORM public._co_support_require_partner(v_uid);
  IF p_rent_request_id IS NULL THEN
    RAISE EXCEPTION 'PLAN_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM public._co_support_lock(p_rent_request_id, v_uid);
  PERFORM public._co_support_expire_stale(p_rent_request_id);

  SELECT * INTO v_inv FROM public.co_support_invites
   WHERE rent_request_id = p_rent_request_id AND status = 'open';
  IF FOUND THEN
    IF v_inv.lead_partner_id = v_uid THEN
      RETURN public._co_support_invite_json(v_inv.id, v_uid) || jsonb_build_object('idempotent_replay', true);
    END IF;
    RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: Another partner is already sharing this Rent Plan. Choose another one.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[p_rent_request_id]);
  v_s := public._co_support_lead_checks(v_uid, p_rent_request_id);

  INSERT INTO public.co_support_invites (
    code, rent_request_id, lead_partner_id, rent_amount, gross_amount,
    lead_rent, invitee_rent, lead_share, invitee_share, expires_at
  ) VALUES (
    public._co_support_new_code(), p_rent_request_id, v_uid,
    (v_s->>'rent')::numeric, (v_s->>'gross')::numeric,
    (v_s->>'lead_rent')::numeric, (v_s->>'invitee_rent')::numeric,
    (v_s->>'lead_share')::numeric, (v_s->>'invitee_share')::numeric,
    now() + interval '48 hours'
  ) RETURNING * INTO v_inv;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_invite_created', 'co_support_invites', v_inv.id,
    jsonb_build_object('rent_request_id', p_rent_request_id, 'lead_share', v_inv.lead_share,
                       'invitee_share', v_inv.invitee_share, 'expires_at', v_inv.expires_at));

  RETURN public._co_support_invite_json(v_inv.id, v_uid);
END;
$$;

-- Anyone with the code may read the invitation (it carries what a public plan
-- link already shows). A signed-in caller also learns whether they can accept.
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
    WHEN NOT public._pipeline_switch_on('funder_direct_release') THEN 'paused'
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

-- Partner B accepts. Both halves are paid and the landlord float is released
-- in this one transaction, or nothing happens.
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
BEGIN
  PERFORM public._co_support_require_partner(v_uid);

  SELECT id, rent_request_id, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', true);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this Rent Plan. Send the link to the partner who will support it with you.'
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
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this Rent Plan cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
  PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);

  -- Close the invite first: this ends the lead's hold, so their half can be spent here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

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

  IF v_problem IS NOT NULL THEN
    -- The plan went elsewhere. Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent on this plan changed after it was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

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

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  -- Direct release: debit each partner, pay each half's fee, and (on the
  -- second half) release the full rent to the agent's landlord float.
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

-- Partner B says no. The plan stays held for the lead until the 48 hours end,
-- so the lead can re-invite, invite someone else, pay alone or cancel.
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
  SELECT id, rent_request_id, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_peek.lead_partner_id);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: To stop sharing this Rent Plan, cancel it instead.' USING ERRCODE = 'check_violation';
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

-- The lead stops sharing. Their half is free again at once.
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
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
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

-- The lead asks again. p_new_link = false keeps the same link for the same
-- person (and clears a decline); true makes a new link for someone else and
-- the old link stops working. Either way: 48 more hours, halves recomputed.
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
BEGIN
  PERFORM public._co_support_require_partner(v_uid);
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed. Start a new one from the Rent Plan.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Step this invite aside so the plan checks below see the plan as free.
  UPDATE public.co_support_invites
     SET status = 'replaced', closed_at = now(), close_reason = 'reinvited', updated_at = now()
   WHERE id = v.id;

  IF EXISTS (SELECT 1 FROM public.co_support_invites
              WHERE rent_request_id = v.rent_request_id AND status = 'open' AND id <> v.id) THEN
    RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: Another partner is already sharing this Rent Plan.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
  v_s := public._co_support_lead_checks(v_uid, v.rent_request_id);

  IF p_new_link THEN
    INSERT INTO public.co_support_invites (
      code, rent_request_id, lead_partner_id, rent_amount, gross_amount,
      lead_rent, invitee_rent, lead_share, invitee_share, expires_at, replaces_id
    ) VALUES (
      public._co_support_new_code(), v.rent_request_id, v_uid,
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

-- The lead pays the whole Rent Plan alone (operational float only).
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
BEGIN
  PERFORM public._co_support_require_partner(v_uid);
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.co_support_invites
     SET status = 'funded_alone', closed_at = now(), close_reason = 'funded_alone', updated_at = now()
   WHERE id = v.id;

  v_need := public.self_support_gross(v.rent_amount);
  v_avail := public.funder_support_capacity(v_uid);
  IF v_avail < v_need THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: The full Rent Plan is UGX %. You have UGX % of operational float. Add float to your wallet, then try again.',
      public._co_support_fmt(v_need), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;

  v_res := public.funder_support_tenant_direct(ARRAY[v.rent_request_id], NULL, 1);

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_funded_alone', 'co_support_invites', v.id,
    jsonb_build_object('amount', v_need, 'result', v_res));

  RETURN v_res || jsonb_build_object('co_support_id', v.id, 'ok', true);
END;
$$;

-- Invitations I started or accepted, newest first.
CREATE OR REPLACE FUNCTION public.co_support_my_invites()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(public._co_support_invite_json(i.id, v_uid) ORDER BY i.created_at DESC)
      FROM (SELECT id, created_at FROM public.co_support_invites
             WHERE lead_partner_id = v_uid OR invitee_id = v_uid
             ORDER BY created_at DESC LIMIT 50) i
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 11b. Staff cancellation is pair-aware.
--   Today a staff member cancels self-support funding by setting a funding
--   line to 'cancelled'; trigger trg_psm_release_plan_on_line_cancel then
--   releases the whole plan (landlord float reversed, plan back on the list).
--   On a co-supported plan that would leave the other half earning on a plan
--   with no landlord float. Now: cancelling either half cancels both, the plan
--   is released exactly once, and both partners are written down as owed a
--   refund (refunds stay a finance step, as for one partner today).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_release_plan_on_line_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_closed integer;
  v_res jsonb;
BEGIN
  IF NEW.status = 'cancelled' AND COALESCE(OLD.status,'') <> 'cancelled' AND NEW.rent_request_id IS NOT NULL THEN
    IF NEW.co_support_id IS NULL THEN
      PERFORM public.psm_release_self_funding_line(NEW.id, 'Self-support funding line cancelled — plan auto-released');
      RETURN NEW;
    END IF;

    -- Co-support: the other half cannot stay funded on a released plan.
    UPDATE public.partner_self_funding_lines
       SET status = 'cancelled', end_reason = COALESCE(end_reason, 'co_support_pair_cancelled'), updated_at = now()
     WHERE co_support_id = NEW.co_support_id AND id <> NEW.id AND status <> 'cancelled';

    -- Exactly once per pair: whichever run closes the invitation releases the plan.
    UPDATE public.co_support_invites
       SET status = 'cancelled', closed_at = now(), close_reason = 'funding_cancelled', updated_at = now()
     WHERE id = NEW.co_support_id AND status = 'completed';
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    IF v_closed > 0 THEN
      v_res := public.psm_release_self_funding_line(NEW.id, 'Co-supported Rent Plan cancelled — both halves released');
      IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
        UPDATE public.co_support_invites SET close_reason = 'funding_cancelled_release_blocked', updated_at = now()
         WHERE id = NEW.co_support_id;
      END IF;

      -- One row per partner: the half they paid, for the finance refund step.
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      SELECT l.partner_id, 'co_support_funding_cancelled', 'co_support_invites', NEW.co_support_id::text,
             'Co-supported Rent Plan cancelled: this partner''s half is due back',
             jsonb_build_object('line_id', l.id, 'commitment_id', l.commitment_id, 'rent_request_id', l.rent_request_id,
                                'amount_paid', l.principal, 'rent_part', l.rent_amount, 'fee_part', l.proxy_fee,
                                'plan_release', v_res)
        FROM public.partner_self_funding_lines l
       WHERE l.co_support_id = NEW.co_support_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- psm_release_self_funding_line: live body + refuse one half of a pair.
CREATE OR REPLACE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$@@RELEASE_BODY@@$function$;

-- Partner Ops: cancel a co-supported plan's funding (both halves) with a reason.
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
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id AND a.source = 'partner_self_funding'
       AND COALESCE(a.paid_out_amount, 0) > 0
  ) THEN
    RAISE EXCEPTION 'LANDLORD_ALREADY_PAID: The landlord has already been paid from this float, so the funding cannot be cancelled here.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_reason := 'staff_cancelled: ' || btrim(p_reason);
  -- Both halves in one statement; the line trigger releases the plan once.
  UPDATE public.partner_self_funding_lines
     SET status = 'cancelled', end_reason = v_reason, updated_at = now()
   WHERE co_support_id = v.id AND status <> 'cancelled';

  SELECT status INTO v_after FROM public.co_support_invites WHERE id = v.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'co_support_staff_cancel', 'co_support_invites', v.id::text, btrim(p_reason),
          jsonb_build_object('rent_request_id', v.rent_request_id,
                             'lead_partner_id', v.lead_partner_id, 'invitee_id', v.invitee_id));

  RETURN jsonb_build_object(
    'success', v_after = 'cancelled',
    'rent_request_id', v.rent_request_id,
    'plan_released', v_after = 'cancelled',
    'refunds_due', (
      SELECT jsonb_agg(jsonb_build_object('partner_id', l.partner_id,
                                          'partner_first_name', public._co_support_first_name(l.partner_id),
                                          'amount', l.principal, 'commitment_id', l.commitment_id)
                       ORDER BY (l.partner_id = v.lead_partner_id) DESC)
        FROM public.partner_self_funding_lines l WHERE l.co_support_id = v.id),
    'note', 'Both halves are cancelled and the plan is back on the list. Refund each partner their half through the usual finance step.');
END;
$$;
REVOKE ALL ON FUNCTION public.co_support_staff_cancel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_support_staff_cancel(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Health check: every row returned is a money problem to look at now.
--     Expected result: no rows. (service_role / database owner only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.co_support_integrity_check()
RETURNS TABLE (invite_id uuid, rent_request_id uuid, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH done AS (
    SELECT i.* FROM public.co_support_invites i WHERE i.status = 'completed'
  ), lines AS (
    SELECT d.id, count(l.id) AS n,
           COALESCE(sum(l.rent_amount), 0) AS rent,
           COALESCE(sum(l.principal), 0) AS principal,
           count(l.id) FILTER (WHERE l.status NOT IN ('active', 'completed')) AS not_live
      FROM done d
      LEFT JOIN public.partner_self_funding_lines l ON l.co_support_id = d.id AND l.status <> 'cancelled'
     GROUP BY d.id
  )
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
   WHERE l.status <> 'cancelled' AND i.status <> 'completed';
$$;
REVOKE ALL ON FUNCTION public.co_support_integrity_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.co_support_integrity_check() TO service_role;

-- ---------------------------------------------------------------------------
-- 13. Grants. New functions are closed by default; open only these.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.co_support_create(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_accept(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_decline(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_reinvite(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_fund_alone(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_my_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.co_support_preview(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.co_support_create(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_accept(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_decline(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_cancel(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_reinvite(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_fund_alone(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.co_support_my_invites() TO authenticated, service_role;
-- The link page runs before sign-in too (new people go to funder-onboarding).
GRANT EXECUTE ON FUNCTION public.co_support_preview(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.co_support_create(uuid) IS
  'Co-support: the caller (a partner with a signed agreement and their half as operational float) starts sharing one Rent Plan 50/50. Holds the plan and the caller''s half for 48 hours. Returns the link code.';
COMMENT ON FUNCTION public.co_support_accept(text) IS
  'Co-support: the second partner accepts. Both halves become their own portfolios, both wallets are debited, and the full rent goes to the agent landlord float once, all in one transaction.';

-- ---------------------------------------------------------------------------
-- 14. Last step on purpose: adding this foreign key takes a SHARE ROW EXCLUSIVE
--     lock on rent_requests (it blocks writes to rent_requests) until the
--     migration commits. Done last, that block lasts only for the commit.
-- ---------------------------------------------------------------------------
ALTER TABLE public.co_support_invites
  DROP CONSTRAINT IF EXISTS co_support_invites_rent_request_id_fkey;
ALTER TABLE public.co_support_invites
  ADD CONSTRAINT co_support_invites_rent_request_id_fkey
  FOREIGN KEY (rent_request_id) REFERENCES public.rent_requests(id);
