-- Rollback of 20261108161000_partner_return_policy_phase2 (DATA-FORWARD): every place that creates a portfolio, a
-- promissory note or a quoted Returns figure goes back to the exact production text it had before Phase 2, the Phase 2
-- helpers and triggers are removed, and the switch stays unable to go on (release_ready false).
--
-- RESTORED, byte for byte: each function below is the production text read with pg_get_functiondef on 2026-11-06; its
-- md5 equals supabase/tests/partner_return_policy/prod_function_manifest.json, and the last block of this file checks
-- that again (a mismatch, for example CRLF line endings, aborts the whole rollback). 22 functions:
--   B funder_create_pending_portfolio, psm_confirm_commitment_for, partner_support_houses (3 and 4 arguments),
--     countersign_prepare_support, get_countersign_summary, create_pending_portfolio, hr_pay_post_staff_reinvestment
--   C agent_create_promissory_note, psm_queue_promissory_pledge_notice, agent_create_promissory_note_for_houses,
--     psm_queue_house_booking_notice
--   D enqueue_funder_house_notice, get_or_create_house_share_link, get_supporter_pool_stats,
--     agent_list_empty_house_opportunities and empty_house_opportunity_summary (the Phase 2 signatures with
--     p_quote_for / p_partner_id are dropped; the production signatures are created again, owned by postgres, execute
--     for authenticated and service_role only, as in production), get_or_create_plan_share_link,
--     public_house_support_offer, public_support_plan, partner_supported_house_returns (the partner's list of houses
--     booked through promissory notes: Returns at the fixed 15% again, no 'return_rate' key)
--   E post_rent_facilitation_reward: the fixed 15% again, and production's wording with it (its three ledger
--     descriptions say "ROI" and the caller's wallet text is used as given; Phase 2 had changed both)
--   F assert_partner_return_policy_intact: Phase 1's checks again (text copied from 20261108160000), so the 10-minute
--     drift check stops expecting Phase 2 objects.
-- CREATE OR REPLACE keeps each function's owner and grants; Phase 2 changed neither for these functions.
--
-- REMOVED, only after every function that called them is restored (no CASCADE: an unexpected dependant stops the
-- rollback): triggers trg_zz_partner_note_linked_late (promissory_notes), trg_zz_stamp_rent_reward_rate_ins and
-- trg_zz_stamp_rent_reward_rate_upd (rent_requests), which Phase 2 creates with CREATE OR REPLACE TRIGGER; functions
-- agent_create_promissory_notes_split, partner_quote_rate, _partner_commitment_follow_rate, partner_rate_now,
-- partner_note_linked_late, stamp_rent_facilitation_reward_rate, _promissory_note_rate_json,
-- _promissory_note_notice_contacts.
--
-- KEPT on purpose (data and audit; no table, column or row is dropped or deleted):
--   * rent_facilitation_reward_rates, with its RLS policy and grants: the rate each legacy rent-facilitation funding
--     was decided at. Nothing reads it after this file (the restored reward pays the fixed 15%); re-applying Phase 2
--     reuses it (its backfill adds the missing rows and re-decides a row whose supporter changed meanwhile).
--   * return_rate on promissory_note_pledge_notices, promissory_house_booking_notices and
--     funder_house_progress_notices: nullable metadata. Rows queued under Phase 2 keep their figure; the restored
--     queue functions leave it empty, as rows queued before Phase 2 are.
--   * portfolio_rate_approvals, including the 'note_late_link' requests: the CFO's queue and decisions. A pending
--     request can still be decided with cfo_decide_portfolio_rate_requests() and applied by the Phase 1 job.
--   * promissory_notes.return_rate values the late-link trigger raised: each note keeps the rate it shows.
--
-- THE SWITCH. The restored paths type 15 (payroll 20) and write 15 on the self-managed commitment, funding lines and
-- houses. With the switch off that is exactly today's behaviour (the Phase 1 gate accepts a typed rate). With it on,
-- the gate would store the person's rate instead of every typed 15 that differs and queue that 15 for the CFO, while
-- the commitment rows kept paying 15, and offers would still quote 15 to new partners. So this file:
--   * refuses to run while the switch is on (the CEO switches it off first with set_partner_return_policy());
--   * holds the policy row from that check to its commit, so the switch cannot go on half-way;
--   * makes sure release_ready is false. Phase 2 does not set it (the release migration, Phase 7, does, after the
--     agreements, edge functions and screens), so after Phases 1 and 2 alone it is already false and step 4 writes
--     nothing. If a release did set it and was not rolled back first, step 4 clears it (audited and e-mailed by the
--     Phase 1 policy guard). That flag is what keeps the switch off afterwards: the restored Phase 1 checks do not
--     look for Phase 2's paths, so the guard's "every check passes" test alone would not notice they are gone.
--     set_partner_return_policy() refuses to switch on until Phase 2 and the release are re-applied. The cut-off is
--     never touched.
--
-- RUN ORDER: newest first. Roll back any later Partner Returns migration first (none is in supabase/migrations on
-- 2026-11-06; the release migration's own rollback should clear release_ready), then this file, then the Phase 1
-- rollback (20261108160000_partner_return_policy_phase1.rollback.sql). Phase 2's paths insert no rate and let the
-- Phase 1 gate decide; run the other way round, they would keep running without the gate they were written for.
-- Both rollbacks clear release_ready, so either way the switch cannot be turned on again.
-- Before running, revert any app or edge-function code that calls partner_quote_rate or
-- agent_create_promissory_notes_split, passes p_quote_for / p_partner_id to agent_list_empty_house_opportunities
-- or empty_house_opportunity_summary, or reads 'return_rate' from partner_supported_house_returns: those calls fail
-- or find nothing afterwards (none exists in the code on 2026-11-06).
-- Run it outside the 00:00, 06:00, 15:00-16:10 and 21:00 UTC jobs, as the owner (postgres), from the file as committed
-- (LF line endings, client_encoding UTF8: the text is compared byte for byte).
--
-- WHEN PHASE 2 IS RE-APPLIED LATER, check what this window leaves behind:
--   * reward rates: the backfill adds a row for every rent request funded while rolled back and re-decides a row
--     whose supporter changed (ON CONFLICT ... DO UPDATE when the supporter differs), so post_rent_facilitation_reward
--     finds a rate for each. To confirm after re-applying, this returns no rows:
--       SELECT rr.id FROM public.rent_requests rr
--         LEFT JOIN public.rent_facilitation_reward_rates x ON x.rent_request_id = rr.id
--        WHERE rr.supporter_id IS NOT NULL AND rr.supporter_id IS DISTINCT FROM x.supporter_id;
--   * once the cut-off is set, a promissory note linked to its person while rolled back queued no 'note_late_link'
--     request (the trigger sees only links made while it exists); review notes linked in the window by hand.
--
-- LOCKS: ACCESS EXCLUSIVE on promissory_notes, then rent_requests, taken once, up front, in the migration's order.
-- The migration needs only SHARE ROW EXCLUSIVE there (CREATE OR REPLACE TRIGGER); DROP TRIGGER needs ACCESS
-- EXCLUSIVE, and taking it at once means no lock is upgraded midway. The notice tables are not locked: nothing in
-- them changes. The transaction is short (function text only). If a lock is not granted within 5 s the rollback
-- stops with nothing changed; run it again.
--
-- One transaction (BEGIN ... COMMIT below). Idempotent: safe to run twice, and safe if Phase 2 was never applied
-- (Phase 1 must be in place).
BEGIN;
SET LOCAL lock_timeout = '5s';
-- psql sends this file in the session's client encoding. Pinned to UTF8 (for every statement after this one): a
-- session left at WIN1252 (psql on Windows without PGCLIENTENCODING=UTF8) stored hr_pay_post_staff_reinvestment's
-- em dash as mojibake and the md5 check in step 5a refused the rollback (md5 8d0961a4...), which looked
-- intermittent from shell to shell.
SET client_encoding = 'UTF8';

-- 0. Strong locks once, up front, in the migration's order.
LOCK TABLE public.promissory_notes, public.rent_requests IN ACCESS EXCLUSIVE MODE;

-- 1. Refuse while the switch is on, and hold the policy row until this transaction ends.
DO $switch$
DECLARE
  v_on boolean;
BEGIN
  SELECT p.enabled INTO v_on FROM public.partner_return_policy p WHERE p.id FOR UPDATE;
  IF COALESCE(v_on, false) THEN
    RAISE EXCEPTION 'PHASE2_ROLLBACK_SWITCH_ON: Partner Returns is switched on. Rolling back Phase 2 must be preceded by the CEO switching it off (set_partner_return_policy); nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
END
$switch$;

-- 2. Production text of every function Phase 2 replaced (pg_get_functiondef, 2026-11-06).

-- -------------------------------------------------------------------------------------------------------------------
-- B. Creation paths: each portfolio is inserted with a typed rate again (15; payroll 20; create_pending_portfolio
--    the caller's rate) and the self-managed commitment, funding lines and houses are written at 15.
-- -------------------------------------------------------------------------------------------------------------------

-- public.funder_create_pending_portfolio(numeric, uuid, integer)  (production md5 6b938de2bbfe96a4f97d82672dbfac7d)
CREATE OR REPLACE FUNCTION public.funder_create_pending_portfolio(p_amount numeric, p_summary_id uuid DEFAULT NULL::uuid, p_term_months integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_available numeric;
  v_reserved numeric;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF NOT public.funder_has_signed_agreement(v_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'Sign your partner agreement before creating a portfolio.';
  END IF;

  PERFORM public.assert_no_promissory_self_support(v_uid, 'funder_create_pending_portfolio');

  IF COALESCE(p_amount,0) < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('funder-pending-' || v_uid::text));

  -- Operational float, already net of portfolios awaiting approval.
  v_available := public.funder_float_capacity(v_uid);
  v_reserved  := GREATEST(0, public.funder_pending_hold(v_uid));

  IF p_amount > v_available THEN
    RAISE EXCEPTION 'Your operational float has UGX % available (UGX % already awaiting approval).',
      round(GREATEST(v_available, 0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_uid ORDER BY created_at LIMIT 1;

  v_code := 'WPF-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, p_amount,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)),
    15, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, summary_id, term_months
  ) VALUES (
    v_portfolio_id, v_uid, p_amount, 'rent_pool', p_summary_id,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'funder_pending_portfolio_created', 'investor_portfolios', v_portfolio_id,
    jsonb_build_object('reason','funder_created_pending_portfolio_awaiting_ops','amount',p_amount,
                       'funding_source','operational_float',
                       'float_usage','portfolio_funding',
                       'float_available_before', v_available));

  RETURN jsonb_build_object(
    'portfolio_id', v_portfolio_id,
    'portfolio_code', v_code,
    'status', 'pending_ops_approval',
    'amount', p_amount,
    'funding_source', 'operational_float',
    'available_balance', public.funder_float_capacity(v_uid)
  );
END;
$function$
;

-- public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid, uuid, text)  (production md5 44692e0de3e7b3ef9be44edb8e158b06)
CREATE OR REPLACE FUNCTION public.psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid, p_promissory_note_id uuid DEFAULT NULL::uuid, p_funding_mode text DEFAULT 'float'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || p_partner::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_reserved numeric;
  v_capacity numeric;
  v_mode text := COALESCE(NULLIF(p_funding_mode,''), 'float');
  v_rate numeric := 15;
  -- The screen no longer decides the term. Promissory-note commitments keep
  -- their own requested term; every other self-support commitment is the
  -- contract term.
  v_term integer := CASE WHEN p_promissory_note_id IS NULL
                         THEN public.psm_contract_term_months()
                         ELSE GREATEST(1, LEAST(COALESCE(p_term_months,1), 12)) END;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_note uuid := p_promissory_note_id;
  v_actor uuid := COALESCE(p_actor, auth.uid(), p_partner);
BEGIN
  IF p_partner IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;
  IF v_mode NOT IN ('withdrawable','float','receivable') THEN
    RAISE EXCEPTION 'INVALID_FUNDING_MODE';
  END IF;

  IF NOT public.funder_has_signed_agreement(p_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  IF v_note IS NULL THEN
    SELECT i.note_id INTO v_note
    FROM public.promissory_note_plan_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id AND n.partner_user_id = p_partner
    WHERE i.rent_request_id = ANY(p_rent_request_ids)
      AND i.status IN ('reserved','funded')
    LIMIT 1;
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(p_partner, p_rent_request_ids);

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count,
                              'status', v_existing.status);
  END IF;

  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, p_partner, p.funding_amount, now() + interval '15 minutes', v_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND (p.held_by IS NULL OR p.held_by = p_partner)
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '15 minutes', updated_at = now()
   WHERE partner_id = p_partner AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = p_partner AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer available. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan funded must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(p_partner);
  v_reserved := public.funder_pending_hold(p_partner);

  IF v_mode = 'withdrawable' THEN
    IF v_total > v_available THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner has UGX % of operational float available (UGX % already awaiting approval).',
        round(v_total), round(GREATEST(v_available,0)), round(v_reserved)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_mode = 'float' THEN
    v_capacity := public.funder_float_available(p_partner);
    IF v_total > v_capacity THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner holds UGX % of operational float.',
        round(v_total), round(GREATEST(v_capacity,0))
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 'receivable': no capacity requirement; the promise is recorded by the caller.

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id
  ) VALUES (
    p_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval', v_note
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, p_partner, c.rent_request_id, c.amount, v_rate, v_term
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = p_partner AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = p_partner AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = p_partner,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months, promissory_note_id
  ) VALUES (v_portfolio_id, p_partner, v_total, 'self_managed', v_commitment_id, v_term, v_note);

  PERFORM public.psm_audit(v_actor, p_partner, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'available_before', v_available,
                       'promissory_note_id', v_note,
                       'funding_mode', v_mode,
                       'idempotency_key', v_key));

  IF v_note IS NOT NULL THEN
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('promissory.self_support.portfolio_created', p_partner, 'promissory_notes', v_note,
              'Promissory partner capital deployed as a self-support portfolio',
              jsonb_build_object('portfolio_id', v_portfolio_id, 'commitment_id', v_commitment_id,
                                 'amount', v_total, 'lines', v_count, 'actor_id', v_actor,
                                 'source', 'self_managed'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'portfolio_id', v_portfolio_id,
    'promissory_note_id', v_note,
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(p_partner)
  );
END;
$function$
;

-- public.partner_support_houses(uuid[], integer, text)  (production md5 c7ffc8dcb0072f424382fd66b232b6bf)
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric := 15;
  v_key text;
  v_total numeric := 0;
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, h.monthly_rent::numeric AS principal,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$
;

-- public.partner_support_houses(uuid[], integer, text, uuid)  (production md5 8a91e283d2429e70c5da6e988cb90844)
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric := 15;
  v_key text;
  v_total numeric := 0;
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
  v_target public.partner_self_commitments%ROWTYPE;
  v_is_topup boolean := p_commitment_id IS NOT NULL;
  v_elig jsonb;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || COALESCE(p_commitment_id::text,'new') || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, h.monthly_rent::numeric AS principal,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_topup THEN
    SELECT * INTO v_target FROM public.partner_self_commitments
     WHERE id = p_commitment_id AND partner_id = v_partner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- A rent-plan portfolio can never absorb house capital: the flows differ.
    IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
                WHERE commitment_id = v_target.id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio funds rent plans, so houses cannot be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT MIN(portfolio_id) INTO v_portfolio_id FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';
    IF v_portfolio_id IS NULL THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio does not hold houses.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_elig := public.partner_self_topup_eligibility(v_target.id);
    IF NOT (v_elig->>'allow_topup')::boolean THEN
      RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason','Top-up not allowed')
        USING ERRCODE = 'check_violation';
    END IF;

    v_commitment_id := v_target.id;
    SELECT MIN(metadata->>'portfolio_code') INTO v_code FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal,
           COALESCE(v_target.monthly_rate, v_rate), COALESCE(v_target.term_months, v_term),
           'pending', p.landlord_id, p.agent_id,
           jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'topup', true)
    FROM _psh_pick p;

    UPDATE public.partner_self_commitments
       SET lines_count = COALESCE(lines_count,0) + v_count, updated_at = now()
     WHERE id = v_commitment_id;

    INSERT INTO public.funder_pending_portfolios (
      portfolio_id, funder_id, amount, source, commitment_id, term_months
    ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house_topup', v_commitment_id,
              COALESCE(v_target.term_months, v_term));

    PERFORM public.psm_audit(v_partner, v_partner, 'house_support_topup_pending_ops_approval',
      'partner_self_commitments', v_commitment_id,
      jsonb_build_object('amount', v_total, 'houses', v_count, 'portfolio_id', v_portfolio_id,
                         'idempotency_key', v_key));

    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'topup', true, 'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * COALESCE(v_target.monthly_rate, v_rate) / 100),
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$
;

-- public.countersign_prepare_support(uuid, numeric, text, text, uuid, boolean)  (production md5 d700308d932151eb828ff4ebbab5815e)
CREATE OR REPLACE FUNCTION public.countersign_prepare_support(p_partner_id uuid, p_amount numeric, p_support_mode text, p_return_option text, p_actor uuid, p_countersign_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a          public.partner_agreements%ROWTYPE;
  v_amount   numeric;
  v_exist    numeric;
  v_count    integer;
  v_needed   numeric;
  v_float    numeric;
  v_option   text;
  v_mode     text;
  v_pid      uuid;
  v_code     text;
  v_group    uuid;
  v_today    date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_roi_mode text;
BEGIN
  IF p_actor IS NULL OR NOT public.is_partner_ops(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED',
      'message', 'Only Partner Operations can countersign.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-' || p_partner_id::text));

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_AGREEMENT', 'message', 'No agreement found for this partner.');
  END IF;

  v_mode := coalesce(p_support_mode, a.support_mode);
  IF v_mode IS NULL OR v_mode NOT IN ('company_managed', 'self_support') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUPPORT_MODE_REQUIRED',
      'message', 'Choose how this partner will support (company-managed or self-support) before countersigning.');
  END IF;

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  IF v_amount < 20000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT',
      'message', 'The contract amount must be at least UGX 20,000.');
  END IF;

  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  IF p_countersign_only AND v_needed > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONTRACT_NOT_COVERED', 'needed', v_needed,
      'message', format('The contract (UGX %s) is more than this partner''s portfolios (UGX %s). Countersign from the Sign-off dialog so the difference is handled.',
                        to_char(v_amount, 'FM999,999,999,999'), to_char(v_exist, 'FM999,999,999,999')));
  END IF;

  IF v_float < v_needed THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLOAT_SHORT',
      'needed', v_needed, 'float_available', v_float, 'shortfall', v_needed - v_float,
      'message', format('Operational float is short by UGX %s. Needed UGX %s, available UGX %s. Nothing was sent.',
                        to_char(v_needed - v_float, 'FM999,999,999,999'),
                        to_char(v_needed, 'FM999,999,999,999'), to_char(v_float, 'FM999,999,999,999')));
  END IF;

  -- A self-registered funder must be verified by Partner Ops before any
  -- portfolio can be created for them (enforce_funder_verified_for_portfolio).
  -- Refuse cleanly here instead of letting the trigger raise a 500.
  IF v_mode = 'company_managed' AND v_needed > 0 AND EXISTS (
       SELECT 1 FROM public.profiles pr
        WHERE pr.id = p_partner_id
          AND pr.signup_source = 'funder-onboarding'
          AND pr.funder_verified_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FUNDER_NOT_VERIFIED',
      'message', 'This partner signed up on their own and has not been verified yet. Verify the partner first, then countersign. Nothing was sent.');
  END IF;

  v_option := coalesce(
    CASE WHEN p_return_option IN ('A', 'B') THEN p_return_option END,
    CASE WHEN a.return_option IN ('A', 'B') THEN a.return_option END,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A' WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1),
    'A');

  IF v_mode = 'company_managed' AND v_needed > 0 THEN
    v_roi_mode := CASE v_option WHEN 'A' THEN 'monthly_payout' ELSE 'monthly_compounding' END;

    v_pid := gen_random_uuid();
    LOOP
      v_code := 'WIP' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = v_code);
    END LOOP;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_partner_id, 'amount', v_needed, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'description', format('Operational float deployed to portfolio %s on agreement countersign (float_usage=partner_portfolio_funding)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', 'platform'),
        jsonb_build_object(
          'amount', v_needed, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'description', format('Platform capital received for portfolio %s (agreement countersign)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', p_partner_id::text)),
      idempotency_key := 'portfolio-funding-' || v_pid::text);

    INSERT INTO public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day,
      next_roi_date, maturity_date, status, portfolio_pin, activation_token, auto_reinvest,
      cfo_verified, cfo_verified_at, cfo_verified_by
    ) VALUES (
      v_pid, p_partner_id, p_partner_id, v_code, v_needed,
      15, v_roi_mode, 12, least(extract(day FROM v_today)::int, 28),
      (v_today + interval '1 month')::date, (v_today + interval '12 months')::date,
      'active', lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), false,
      true, now(), p_actor
    );

    INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, description)
    VALUES (p_partner_id, p_partner_id, v_needed, 'Portfolio funded: ' || v_code);

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (p_actor, 'countersign_auto_portfolio', 'investor_portfolios', v_pid::text,
      'countersign_auto_portfolio', 'Portfolio created automatically on agreement countersign (company-managed)',
      jsonb_build_object('partner_id', p_partner_id, 'contract_amount', v_amount, 'existing_total', v_exist,
                         'created_amount', v_needed, 'portfolio_code', v_code, 'return_option', v_option,
                         'ledger_group_id', v_group, 'float_before', v_float));
  END IF;

  UPDATE public.partner_agreements
     SET partnership_amount = v_amount,
         partnership_amount_words = CASE WHEN partnership_amount IS DISTINCT FROM v_amount THEN NULL ELSE partnership_amount_words END,
         return_option = v_option,
         support_mode = v_mode,
         support_mode_set_at = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN now() ELSE support_mode_set_at END,
         support_mode_set_by = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN p_actor ELSE support_mode_set_by END,
         self_support_allowance = CASE WHEN v_mode = 'self_support' THEN v_needed ELSE NULL END,
         auto_portfolio_id = coalesce(v_pid, auto_portfolio_id)
   WHERE id = a.id;

  RETURN jsonb_build_object('ok', true, 'support_mode', v_mode, 'contract_amount', v_amount,
    'existing_total', v_exist, 'needed', v_needed, 'float_available', v_float,
    'portfolio_id', v_pid, 'portfolio_code', v_code, 'return_option', v_option,
    'self_support_allowance', CASE WHEN v_mode = 'self_support' THEN v_needed END);
END;
$function$
;

-- public.get_countersign_summary(uuid, numeric)  (production md5 d72f5a66332b4ab9ffb35c3ee037a423)
CREATE OR REPLACE FUNCTION public.get_countersign_summary(p_partner_id uuid, p_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a        public.partner_agreements%ROWTYPE;
  v_amount numeric;
  v_exist  numeric;
  v_count  integer;
  v_float  numeric;
  v_needed numeric;
  v_option text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id;
  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  v_option := coalesce(
    CASE WHEN a.return_option IN ('A', 'B') THEN a.return_option END,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A'
                             WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1),
    'A');

  RETURN jsonb_build_object(
    'contract_amount', v_amount,
    'stored_amount', coalesce(a.partnership_amount, 0),
    'existing_total', v_exist,
    'existing_count', v_count,
    'needed', v_needed,
    'float_available', v_float,
    'shortfall', greatest(0, v_needed - v_float),
    'covered', v_float >= v_needed,
    'return_option', v_option,
    'support_mode', a.support_mode,
    'countersigned', a.countersigned_at IS NOT NULL OR a.status = 'countersigned',
    'self_support_remaining', CASE WHEN a.support_mode = 'self_support' THEN v_needed END,
    'roi_percentage', 15,
    'duration_months', 12
  );
END;
$function$
;

-- public.create_pending_portfolio(uuid, numeric, integer, numeric, text, text, text)  (production md5 10094e3dafd79c145070c81c1f3ea5ec)
CREATE OR REPLACE FUNCTION public.create_pending_portfolio(p_partner_id uuid, p_amount numeric, p_duration_months integer, p_roi_percentage numeric, p_roi_mode text, p_nickname text, p_raw_token text)
 RETURNS TABLE(portfolio_id uuid, portfolio_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_email text;
  v_partner_phone text;
  v_ref text;
  v_pid uuid;
  v_pin text;
  v_payout_day int;
  v_next_roi date;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING HINT = 'not_signed_in';
  END IF;

  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING HINT = 'only_partner_ops_can_create_portfolios';
  END IF;

  -- Promissory-linked partners are self-support only.
  PERFORM public.assert_no_promissory_self_support(p_partner_id, 'create_pending_portfolio');

  IF p_amount IS NULL OR p_amount < 20000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING HINT = 'amount_below_minimum';
  END IF;

  IF p_duration_months IS NULL OR p_duration_months < 1 OR p_duration_months > 60 THEN
    RAISE EXCEPTION 'INVALID_DURATION' USING HINT = 'duration_out_of_range';
  END IF;

  IF p_roi_percentage IS NULL OR p_roi_percentage <= 0 OR p_roi_percentage > 100 THEN
    RAISE EXCEPTION 'INVALID_ROI' USING HINT = 'roi_out_of_range';
  END IF;

  IF p_roi_mode NOT IN ('monthly_payout','monthly_compounding') THEN
    RAISE EXCEPTION 'INVALID_MODE' USING HINT = 'roi_mode_invalid';
  END IF;

  IF p_raw_token IS NULL OR length(p_raw_token) < 32 THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING HINT = 'token_too_short';
  END IF;

  SELECT email, phone INTO v_partner_email, v_partner_phone
  FROM public.profiles WHERE id = p_partner_id;

  IF v_partner_email IS NULL AND v_partner_phone IS NULL THEN
    RAISE EXCEPTION 'PARTNER_MISSING_CONTACT' USING HINT = 'no_email_or_phone';
  END IF;

  v_ref := 'WIP' ||
    to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') ||
    lpad((floor(random()*9000)+1000)::int::text, 4, '0');
  v_pin := lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  v_payout_day := LEAST(EXTRACT(day FROM (now() AT TIME ZONE 'UTC'))::int, 28);
  v_next_roi := ((now() AT TIME ZONE 'UTC')::date + INTERVAL '1 month')::date;

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount,
    roi_percentage, roi_mode, duration_months, payout_day,
    next_roi_date, status, portfolio_pin, activation_token, auto_reinvest
  )
  VALUES (
    p_partner_id, p_partner_id, v_ref, p_amount,
    p_roi_percentage, p_roi_mode, p_duration_months, v_payout_day,
    v_next_roi, 'awaiting_partner_details', v_pin, gen_random_uuid(), false
  )
  RETURNING id INTO v_pid;

  INSERT INTO public.portfolio_completion_tokens (
    portfolio_id, partner_id, token_hash,
    email_snapshot, phone_snapshot, created_by
  )
  VALUES (
    v_pid, p_partner_id, encode(extensions.digest(p_raw_token, 'sha256'), 'hex'),
    v_partner_email, v_partner_phone, v_caller
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'create_pending_portfolio', 'investor_portfolios', v_pid,
    jsonb_build_object(
      'partner_id', p_partner_id,
      'amount', p_amount,
      'roi_percentage', p_roi_percentage,
      'duration_months', p_duration_months,
      'roi_mode', p_roi_mode,
      'nickname', p_nickname,
      'payout_day', v_payout_day,
      'next_roi_date', v_next_roi,
      'reason', 'partner_completion_invite_sent'
    )
  );

  RETURN QUERY SELECT v_pid, v_ref;
END;
$function$
;

-- public.hr_pay_post_staff_reinvestment(uuid)  (production md5 ed4cc123465f945d282e109f8770a22b)
CREATE OR REPLACE FUNCTION public.hr_pay_post_staff_reinvestment(_payslip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing   public.hr_pay_staff_reinvestments%rowtype;
  v_ps         record;
  v_amount     numeric;
  v_pct        smallint;
  v_mode       text;
  v_disb       text;
  v_pid        uuid;
  v_code       text;
  v_group      uuid;
  v_op         uuid;
  v_kind       text;
  v_payout_day int;
begin
  perform pg_advisory_xact_lock(hashtext('staff-reinvest-' || _payslip_id::text));

  select * into v_existing from public.hr_pay_staff_reinvestments where payslip_id = _payslip_id;
  if v_existing.id is not null then
    return jsonb_build_object('status', 'already_posted', 'portfolio_id', v_existing.portfolio_id,
                              'amount', v_existing.amount);
  end if;

  select ps.id, ps.run_id, ps.staff_id, ps.is_current, ps.inputs_snapshot, ps.net,
         s.user_id, s.staff_ref, r.status as run_status, pe.code as period_code
    into v_ps
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  join public.hr_pay_runs r on r.id = ps.run_id
  join public.hr_pay_periods pe on pe.id = r.period_id
  where ps.id = _payslip_id;

  if v_ps.id is null then raise exception 'PAYSLIP_NOT_FOUND'; end if;
  if not v_ps.is_current then raise exception 'PAYSLIP_NOT_CURRENT'; end if;
  if v_ps.run_status not in ('approved','paid','locked') then
    raise exception 'RUN_NOT_APPROVED' using hint = v_ps.run_status;
  end if;

  select coalesce(sum(l.amount), 0) into v_amount
    from public.hr_pay_payslip_lines l
   where l.payslip_id = _payslip_id and l.component_code = 'REINVEST';
  if v_amount <= 0 then
    return jsonb_build_object('status', 'none');
  end if;

  select d.status into v_disb from public.hr_pay_disbursements d where d.payslip_id = _payslip_id limit 1;
  if coalesce(v_ps.net, 0) > 0 and coalesce(v_disb, '') not in ('posted','skipped') then
    raise exception 'SALARY_NOT_RELEASED' using hint = coalesce(v_disb, 'no disbursement');
  end if;

  if v_ps.user_id is null then raise exception 'STAFF_HAS_NO_USER'; end if;

  v_pct := nullif(v_ps.inputs_snapshot->'reinvestment'->>'percentage', '')::smallint;
  v_mode := nullif(v_ps.inputs_snapshot->'reinvestment'->>'payout_mode', '');
  if v_mode is null then
    select r.payout_mode into v_mode
      from public.staff_survey_responses r
      join public.staff_surveys sv on sv.id = r.survey_id and sv.kind = 'reinvestment_pledge'
     where r.user_id = v_ps.user_id and r.response = 'pledge' and r.payout_mode is not null
     order by r.cycle_start desc, r.responded_at desc
     limit 1;
  end if;
  if v_mode is null then raise exception 'RETURN_OPTION_NOT_CHOSEN'; end if;

  select r.portfolio_id into v_pid
    from public.hr_pay_staff_reinvestments r
    join public.investor_portfolios ip on ip.id = r.portfolio_id
   where r.user_id = v_ps.user_id
     and ip.status in ('pending_ops_approval','awaiting_partner_details','active')
   order by r.created_at desc
   limit 1;

  if v_pid is null then
    v_kind := 'portfolio_created';
    v_pid := gen_random_uuid();
    v_code := 'WSR' || to_char(now() at time zone 'UTC', 'YYMMDD')
              || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
    v_payout_day := least(extract(day from (now() at time zone 'UTC'))::int, 28);

    insert into public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day, next_roi_date,
      status, portfolio_pin, activation_token, auto_reinvest, investment_reference
    ) values (
      v_pid, v_ps.user_id, v_ps.user_id, v_code, v_amount,
      20, v_mode, 12, v_payout_day, ((now() at time zone 'UTC')::date + interval '1 month')::date,
      'awaiting_partner_details', lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
      gen_random_uuid(), false,
      'Staff salary reinvestment · ' || coalesce(v_ps.staff_ref, '')
    );

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' into staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'partner_funding',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment capital received for portfolio ' || v_code
                         || ' (float_usage=portfolio_funding)')
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );
  else
    v_kind := 'topup';
    select portfolio_code into v_code from public.investor_portfolios where id = v_pid;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' as a top-up to staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'pending_portfolio_topup',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment top-up parked for portfolio ' || v_code)
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );

    insert into public.pending_wallet_operations (
      user_id, amount, direction, category, description, source_table, source_id,
      transaction_group_id, linked_party, reference_id, status, operation_type,
      payment_method, metadata, created_at, updated_at
    ) values (
      v_ps.user_id, v_amount, 'cash_in', 'pending_portfolio_topup',
      'Staff salary reinvestment top-up for ' || v_code,
      'investor_portfolios', v_pid, v_group, v_ps.user_id::text, v_code,
      'pending', 'portfolio_topup', 'payroll',
      jsonb_build_object('fund_source', 'payroll', 'staff_reinvestment', true,
                         'payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                         'portfolio_code', v_code, 'percentage', v_pct,
                         'payout_mode_chosen', v_mode),
      now(), now()
    )
    returning id into v_op;
  end if;

  insert into public.hr_pay_staff_reinvestments (
    payslip_id, run_id, staff_id, user_id, amount, percentage, payout_mode,
    portfolio_id, kind, pending_op_id, ledger_group_id
  ) values (
    _payslip_id, v_ps.run_id, v_ps.staff_id, v_ps.user_id, v_amount, v_pct, v_mode,
    v_pid, v_kind, v_op, v_group
  );

  insert into public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  values (null, 'hr_pay_staff_reinvestment', 'investor_portfolios', v_pid::text,
          'Staff salary reinvestment posted',
          jsonb_build_object('payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                             'staff_ref', v_ps.staff_ref, 'amount', v_amount,
                             'percentage', v_pct, 'payout_mode', v_mode, 'kind', v_kind,
                             'portfolio_code', v_code, 'ledger_group_id', v_group));

  insert into public.notifications (user_id, title, message, type, metadata)
  values (v_ps.user_id, 'Salary reinvested',
          format('UGX %s from your %s salary has been reinvested into your Welile portfolio %s, earning 20%% per month.',
                 to_char(v_amount, 'FM999,999,999,999'), v_ps.period_code, v_code),
          'success',
          jsonb_build_object('portfolio_id', v_pid, 'amount', v_amount, 'kind', v_kind));

  return jsonb_build_object('status', 'posted', 'kind', v_kind, 'portfolio_id', v_pid,
                            'portfolio_code', v_code, 'amount', v_amount);
end;
$function$
;

-- -------------------------------------------------------------------------------------------------------------------
-- C. Promissory notes: projections at 15% again; the notice queues stop filling return_rate.
-- -------------------------------------------------------------------------------------------------------------------

-- public.agent_create_promissory_note(jsonb, uuid[])  (production md5 3fc2b24b3cfc9b37dabaa326d3771a97)
CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(p_payload jsonb, p_rent_request_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_support_mode text := COALESCE(NULLIF(btrim(p_payload->>'support_mode'), ''), 'existing_support');
  v_recorded_on date := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'recorded_on','')), '')::date, CURRENT_DATE);
  v_fulfil_on date := NULLIF(btrim(COALESCE(p_payload->>'fulfilment_due_on','')), '')::date;
  v_note public.promissory_notes;
  v_valid integer := 0;
  v_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
    OR EXISTS (
      SELECT 1
      FROM public.partner_lead_assignments pla
      WHERE pla.agent_id = v_uid
        AND pla.detached_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF v_email <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF v_fulfil_on IS NOT NULL AND v_fulfil_on < v_recorded_on THEN
    RAISE EXCEPTION 'FULFILMENT_BEFORE_RECORDED: the fulfilment date cannot be earlier than the recording date.' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode NOT IN ('self_support','existing_support') THEN
    RAISE EXCEPTION 'INVALID_SUPPORT_MODE' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode = 'self_support' AND COALESCE(array_length(v_ids,1),0) = 0 THEN
    RAISE EXCEPTION 'SELF_SUPPORT_PLANS_REQUIRED: select at least one tenant rent plan for self support.' USING ERRCODE = '23514';
  END IF;
  IF v_support_mode = 'existing_support' AND COALESCE(array_length(v_ids,1),0) > 0 THEN
    RAISE EXCEPTION 'EXISTING_SUPPORT_HAS_PLANS: tenant plan selections belong to self support.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    recorded_on, fulfilment_due_on
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(v_email, ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    v_support_mode,
    v_recorded_on, v_fulfil_on
  ) RETURNING * INTO v_note;

  IF COALESCE(array_length(v_ids,1),0) > 0 THEN
    INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount)
    SELECT v_note.id, p.rent_request_id, v_uid, p.funding_amount
    FROM public.v_partner_self_fundable_plans p
    WHERE p.rent_request_id = ANY(v_ids)
      AND p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      );

    SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_valid, v_sum
    FROM public.promissory_note_plan_intents
    WHERE note_id = v_note.id AND status = 'reserved';

    IF v_valid <> array_length(v_ids,1) THEN
      RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again.' USING ERRCODE = '23514';
    END IF;
    IF v_sum > v_amount THEN
      RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note), 'support_mode', v_support_mode,
    'attached_count', v_valid, 'attached_amount', v_sum,
    'monthly_return', round(v_amount * 0.15), 'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$function$
;

-- public.psm_queue_promissory_pledge_notice(uuid)  (production md5 18995fb13e5861b6393e9b5befacb4e7)
CREATE OR REPLACE FUNCTION public.psm_queue_promissory_pledge_notice(p_note_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_note public.promissory_notes;
  v_tenants jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_amount numeric := 0;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tenant_name', COALESCE(v.tenant_full_name, 'Tenant'),
           'tenant_location', COALESCE(v.tenant_location, v.request_city, ''),
           'principal', i.amount
         ) ORDER BY i.amount DESC), '[]'::jsonb),
         COUNT(*), COALESCE(SUM(i.amount), 0)
  INTO v_tenants, v_count, v_amount
  FROM public.promissory_note_plan_intents i
  LEFT JOIN public.v_partner_self_fundable_plans v ON v.rent_request_id = i.rent_request_id
  WHERE i.note_id = p_note_id AND i.status = 'reserved';

  INSERT INTO public.promissory_note_pledge_notices (
    note_id, partner_name, phone, email, amount,
    attached_count, attached_amount, monthly_return, annual_return, tenants
  ) VALUES (
    p_note_id, v_note.partner_name,
    COALESCE(NULLIF(btrim(v_note.whatsapp_number),''), NULLIF(btrim(v_note.phone_number),'')),
    NULLIF(btrim(v_note.email),''),
    v_note.amount, v_count, v_amount,
    round(v_note.amount * 0.15), round(v_note.amount * 0.15 * 12),
    v_tenants
  )
  ON CONFLICT (note_id) DO NOTHING;
END;
$function$
;

-- public.agent_create_promissory_note_for_houses(jsonb, uuid[])  (production md5 c37cf13889aed93c5171c22361cd927c)
CREATE OR REPLACE FUNCTION public.agent_create_promissory_note_for_houses(p_payload jsonb, p_house_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_house_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_promised date := NULLIF(btrim(COALESCE(p_payload->>'promised_funding_date','')), '')::date;
  v_hold timestamptz := now() + interval '7 days';
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent_sum numeric := 0;
  v_is_agent boolean;
  v_is_supporter boolean;
  v_self boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  v_is_agent := public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
                OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid);
  v_is_supporter := public.has_role(v_uid, 'supporter');

  IF NOT (v_is_agent OR v_is_supporter) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;

  v_self := (NOT v_is_agent) AND v_is_supporter;

  IF v_self THEN
    SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), v_name),
           COALESCE(NULLIF(regexp_replace(COALESCE(pr.phone, ''), '\D', '', 'g'), ''), v_whatsapp),
           COALESCE(NULLIF(lower(btrim(COALESCE(pr.email, ''))), ''), v_email)
      INTO v_name, v_whatsapp, v_email
    FROM public.profiles pr WHERE pr.id = v_uid;
  END IF;

  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF COALESCE(v_email,'') <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'HOUSES_REQUIRED: select at least one empty house for this partner.' USING ERRCODE = '23514';
  END IF;
  IF v_promised IS NOT NULL AND v_promised < current_date THEN
    RAISE EXCEPTION 'PROMISED_DATE_PAST: the promised funding date cannot be in the past.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    partner_user_id
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(COALESCE(v_email,''), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    'self_support',
    CASE WHEN v_self THEN v_uid ELSE NULL END
  ) RETURNING * INTO v_note;

  INSERT INTO public.promissory_note_house_intents (
    note_id, house_id, agent_id, listing_agent_id, monthly_rent, reserved_until, promised_funding_date
  )
  SELECT v_note.id, h.id, v_uid, h.agent_id, COALESCE(h.monthly_rent, 0), v_hold, v_promised
  FROM public.house_listings h
  WHERE h.id = ANY(v_ids)
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(monthly_rent), 0) INTO v_count, v_rent_sum
  FROM public.promissory_note_house_intents
  WHERE note_id = v_note.id AND status = 'reserved';

  IF v_count <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses are no longer empty. Refresh and try again.' USING ERRCODE = '23514';
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);
  PERFORM public.psm_queue_house_booking_notice(v_note.id, 'booked');

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note),
    'house_count', v_count,
    'houses_monthly_rent', v_rent_sum,
    'reserved_until', v_hold,
    'promised_funding_date', v_promised,
    'monthly_return', round(v_amount * 0.15),
    'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$function$
;

-- public.psm_queue_house_booking_notice(uuid, text)  (production md5 61efc5de32bd3597014c854224d60ed9)
CREATE OR REPLACE FUNCTION public.psm_queue_house_booking_notice(p_note_id uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent numeric := 0;
  v_release timestamptz;
  v_promised date;
  v_houses jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*), COALESCE(SUM(i.monthly_rent),0), MIN(i.reserved_until), MIN(i.promised_funding_date),
         COALESCE(jsonb_agg(jsonb_build_object(
           'house_id', i.house_id,
           'title', COALESCE(h.title, 'Empty house'),
           'district', COALESCE(h.district, h.region, ''),
           'monthly_rent', i.monthly_rent
         ) ORDER BY i.monthly_rent DESC), '[]'::jsonb)
    INTO v_count, v_rent, v_release, v_promised, v_houses
    FROM public.promissory_note_house_intents i
    LEFT JOIN public.house_listings h ON h.id = i.house_id
   WHERE i.note_id = p_note_id
     AND i.status = CASE p_kind
                      WHEN 'funded' THEN 'funded'
                      WHEN 'released' THEN 'released'
                      WHEN 'given_up' THEN 'released'
                      ELSE 'reserved'
                    END;

  IF COALESCE(v_count,0) = 0 THEN RETURN; END IF;

  INSERT INTO public.promissory_house_booking_notices (
    note_id, partner_user_id, kind, partner_name, phone, email,
    house_count, total_rent, promised_funding_date, release_at, days_left, houses
  ) VALUES (
    p_note_id, v_note.partner_user_id, p_kind, v_note.partner_name,
    COALESCE(NULLIF(btrim(v_note.whatsapp_number),''), NULLIF(btrim(v_note.phone_number),'')),
    NULLIF(btrim(v_note.email),''),
    v_count, v_rent, v_promised, v_release,
    CASE WHEN v_release IS NULL THEN NULL
         ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_release - now())) / 86400))::int END,
    v_houses
  )
  ON CONFLICT (note_id, kind) DO NOTHING;
END;
$function$
;

-- -------------------------------------------------------------------------------------------------------------------
-- D. Quotes and notices: the fixed 15% figures again; the two house listings get their
--    production signatures (no p_quote_for / p_partner_id) and production grants back.
-- -------------------------------------------------------------------------------------------------------------------

-- public.enqueue_funder_house_notice(text, text, uuid, uuid, uuid, uuid, text, text, integer, numeric, numeric, text, timestamp with time zone, timestamp with time zone)  (production md5 ddd9bc1a647be7ab23febd79eedb176b)
CREATE OR REPLACE FUNCTION public.enqueue_funder_house_notice(p_dedupe_key text, p_kind text, p_partner_id uuid, p_supported_house_id uuid, p_house_id uuid, p_commitment_id uuid, p_house_title text, p_district text, p_house_count integer, p_monthly_rent numeric, p_principal numeric, p_agent_name text, p_placed_at timestamp with time zone, p_earning_started_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile record;
  v_monthly_return numeric := round(COALESCE(p_principal, 0) * 0.15);
  v_title text;
  v_message text;
  v_house text := COALESCE(NULLIF(p_house_title, ''), 'your funded house');
  v_id uuid;
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
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN; END IF;

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

  -- Wake the worker for this row only. Never fatal to the caller.
  BEGIN
    PERFORM net.http_post(
      url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-house-progress',
      headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5cnpzaHdsZW50cXZrdGNrc2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTI3MTQsImV4cCI6MjEwNzQ2ODcxNH0.8oMYC39wCMHtVlevN1D8rQnIZgtcwJVpG6z3QnTXnAs"}'::jsonb,
      body := jsonb_build_object('notice_id', v_id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$function$
;

-- public.get_or_create_house_share_link(uuid)  (production md5 5fe498c42fc38723ac2719dcc524fb2b)
CREATE OR REPLACE FUNCTION public.get_or_create_house_share_link(p_house_id uuid)
 RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_h public.house_listings;
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/support-house';
  v_fp text;
  v_place text;
  v_cat text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this house';
  END IF;

  SELECT * INTO v_h FROM public.house_listings WHERE id = p_house_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HOUSE_NOT_FOUND';
  END IF;

  v_cat := NULLIF(btrim(initcap(replace(COALESCE(v_h.house_category, ''), '_', ' '))), '');
  v_place := NULLIF(btrim(concat_ws(', ', NULLIF(v_h.village,''), NULLIF(v_h.sub_county,''), NULLIF(v_h.district,''))), '');
  v_title := COALESCE(NULLIF(btrim(v_h.title), ''), COALESCE(v_cat, 'Empty house'))
             || ' in ' || COALESCE(v_place || ', Uganda', 'Uganda') || ' | Welile';
  v_desc := 'Support this available house through Welile. Pay one month''s rent of UGX '
            || to_char(round(COALESCE(v_h.monthly_rent,0)), 'FM999,999,999')
            || ' and receive UGX ' || to_char(round(COALESCE(v_h.monthly_rent,0) * 0.15), 'FM999,999,999')
            || ' every month for the next 12 months. A family moves in as soon as it is supported.';

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_h.image_urls, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image,'') || '|' || v_title || '|' || v_desc);

  SELECT * INTO v_row FROM public.short_links s
   WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
   LIMIT 1;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest, '{}'::jsonb, 'house_support', p_house_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      ) RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_row FROM public.short_links s
       WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
       LIMIT 1;
    END;
  END IF;

  IF v_row.id IS NOT NULL AND (COALESCE(v_row.target_params->>'s','') <> v_row.code
      OR COALESCE(v_row.og_image_fingerprint,'') <> v_fp) THEN
    UPDATE public.short_links s
       SET target_params = jsonb_build_object('s', s.code),
           target_path = v_dest,
           destination_path = v_dest,
           og_title = v_title,
           og_description = v_desc,
           og_image_url = v_image,
           og_image_fingerprint = v_fp,
           og_updated_at = now()
     WHERE s.id = v_row.id
     RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$function$
;

-- public.get_supporter_pool_stats()  (production md5 a822072a8c929b24eedc9062fad47d67)
CREATE OR REPLACE FUNCTION public.get_supporter_pool_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  total_in numeric;
  total_out numeric;
  total_withdrawn numeric;
begin /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if; 
  SELECT COALESCE(SUM(amount), 0) INTO total_in
  FROM general_ledger WHERE category = 'supporter_rent_fund';

  SELECT COALESCE(SUM(amount), 0) INTO total_out
  FROM general_ledger WHERE category = 'pool_rent_deployment';

  SELECT COALESCE(SUM(amount), 0) INTO total_withdrawn
  FROM general_ledger WHERE category = 'supporter_capital_return';

  RETURN json_build_object(
    'poolBalance', total_in - total_out,
    'totalDeployed', total_out,
    'monthlyObligation', ROUND((total_in - total_withdrawn) * 0.15),
    'deployableAmount', GREATEST(0, (total_in - total_out) - ROUND((total_in - total_withdrawn) * 0.15))
  );
END;
$function$
;

-- public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text)  (production md5 af1b80d1581545b653bc5aae692b49b8)
DROP FUNCTION IF EXISTS public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text, text, uuid);
CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_radius double precision := NULLIF(COALESCE(p_radius_km, 0), 0);
  v_sort text := lower(NULLIF(btrim(COALESCE(p_sort, '')), ''));
  v_dlat double precision;
  v_dlng double precision;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_districts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF v_sort IS NULL OR v_sort NOT IN ('recommended', 'nearest', 'newest', 'rent_high', 'rent_low') THEN
    v_sort := 'recommended';
  END IF;

  IF v_sort = 'nearest' AND (p_near_lat IS NULL OR p_near_lng IS NULL) THEN
    v_sort := 'recommended';
  END IF;

  IF v_radius IS NOT NULL AND p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
    v_dlat := v_radius / 111.0;
    v_dlng := v_radius / GREATEST(cos(radians(p_near_lat)) * 111.0, 0.000001);
  END IF;

  WITH base AS (
    SELECT
      h.id,
      h.verified,
      h.created_at,
      COALESCE(h.monthly_rent, 0) AS monthly_rent,
      CASE
        WHEN p_near_lat IS NULL OR p_near_lng IS NULL
          OR h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE sqrt(
          pow((h.latitude - p_near_lat) * 111.0, 2)
          + pow((h.longitude - p_near_lng) * cos(radians(p_near_lat)) * 111.0, 2)
        )
      END AS distance_km
    FROM public.house_listings h
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN ('reserved','funded'))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses pshc
                       WHERE pshc.house_id = h.id AND pshc.status IN ('pending','active'))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled'))
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.name ILIKE '%' || v_search || '%'
        OR lp.phone ILIKE '%' || v_search || '%'
        OR ap.full_name ILIKE '%' || v_search || '%'
      )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (COALESCE(p_verified_only, false) = false OR COALESCE(h.verified, false) = true)
      AND (
        COALESCE(p_gps_only, false) = false
        OR (h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (h.latitude <> 0 OR h.longitude <> 0))
      )
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (
        v_dlat IS NULL
        OR (
          h.latitude IS NOT NULL AND h.longitude IS NOT NULL
          AND h.latitude BETWEEN p_near_lat - v_dlat AND p_near_lat + v_dlat
          AND h.longitude BETWEEN p_near_lng - v_dlng AND p_near_lng + v_dlng
        )
      )
  ),
  counted AS (SELECT COUNT(*) AS c FROM base),
  page AS (
    SELECT
      b.id,
      b.distance_km,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'nearest' THEN b.distance_km END ASC NULLS LAST,
          CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_high' THEN b.monthly_rent END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_low' THEN b.monthly_rent END ASC NULLS LAST,
          CASE WHEN v_sort = 'recommended' THEN (CASE WHEN b.verified THEN 0 ELSE 1 END) END ASC NULLS LAST,
          b.created_at DESC
      ) AS rn
    FROM base b
    ORDER BY rn
    LIMIT v_limit OFFSET v_offset
  ),
  rows_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'house_id', h.id,
      'title', h.title,
      'house_category', h.house_category,
      'monthly_rent', COALESCE(h.monthly_rent, 0),
      'district', h.district,
      'sub_county', h.sub_county,
      'village', h.village,
      'region', h.region,
      'number_of_rooms', h.number_of_rooms,
      'verified', COALESCE(h.verified, false),
      'listing_agent_id', h.agent_id,
      'listing_agent_name', p.full_name,
      'image_url', CASE WHEN h.image_urls IS NOT NULL AND array_length(h.image_urls, 1) > 0 THEN h.image_urls[1] ELSE NULL END,
      'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
      'latitude', h.latitude,
      'longitude', h.longitude,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * 0.15),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * 0.15 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
  )
  SELECT counted.c, rows_json.j INTO v_total, v_rows FROM counted, rows_json;

  SELECT COALESCE(jsonb_agg(q.d ORDER BY q.d), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT DISTINCT btrim(hl.district) AS d
    FROM public.house_listings hl
    WHERE hl.status = 'available'
      AND hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND COALESCE(hl.monthly_rent, 0) > 0
      AND NULLIF(btrim(COALESCE(hl.district, '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = hl.id
          AND psh.status IN ('pending', 'active')
      )
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts);
END;
$function$
;
ALTER FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text) FROM PUBLIC, anon, authenticated, service_role;  -- all four, so the grants below come back in production's proacl order
GRANT EXECUTE ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text) TO authenticated, service_role;

-- public.empty_house_opportunity_summary()  (production md5 9bb8a0c9765d0ca5e020c733c1cb328b)
DROP FUNCTION IF EXISTS public.empty_house_opportunity_summary(text, uuid);
CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         (
           EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status IN ('reserved','funded'))
           OR EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                       WHERE psh.house_id = h.id AND psh.status IN ('pending','active'))
           OR EXISTS (SELECT 1 FROM public.portfolio_allocations a
                       WHERE a.house_id = h.id AND a.status IN ('reserved','fulfilled'))
         ) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('district', COALESCE(district,'Unspecified'),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(rent),0),
          'monthly_return', COALESCE(SUM(ROUND(rent*0.15)),0)) AS d
        FROM avail GROUP BY COALESCE(district,'Unspecified')
        ORDER BY SUM(rent) DESC LIMIT 12) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('landlord_name', TRIM(p.name),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(a.rent),0),
          'monthly_return', COALESCE(SUM(ROUND(a.rent*0.15)),0)) AS l
        FROM avail a JOIN public.landlords p ON p.id = a.landlord_id
        WHERE NULLIF(TRIM(COALESCE(p.name,'')),'') IS NOT NULL
        GROUP BY TRIM(p.name) ORDER BY SUM(a.rent) DESC LIMIT 8) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent),0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent*0.15)),0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)),0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent),0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts),'[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords),'[]'::jsonb));
$function$
;
ALTER FUNCTION public.empty_house_opportunity_summary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.empty_house_opportunity_summary() FROM PUBLIC, anon, authenticated, service_role;  -- all four, so the grants below come back in production's proacl order
GRANT EXECUTE ON FUNCTION public.empty_house_opportunity_summary() TO authenticated, service_role;

-- public.get_or_create_plan_share_link(uuid)  (production md5 23280e3466b2bcb20163a81a88a6adc9)
CREATE OR REPLACE FUNCTION public.get_or_create_plan_share_link(p_plan_id uuid)
 RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_rent numeric := 0;
  v_category text;
  v_loc text;
  v_images text[];
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/funder-onboarding';
  v_fp text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this plan';
  END IF;

  -- Authoritative plan data (never trust client-supplied preview values).
  SELECT COALESCE(p.funding_amount, 0), p.house_category,
         COALESCE(NULLIF(p.tenant_location, ''), p.request_city), p.house_image_urls
    INTO v_rent, v_category, v_loc, v_images
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id;

  IF NOT FOUND THEN
    SELECT COALESCE(r.rent_amount, 0), r.house_category, r.request_city, r.house_image_urls
      INTO v_rent, v_category, v_loc, v_images
    FROM public.rent_requests r
    WHERE r.id = p_plan_id;
  END IF;

  v_category := NULLIF(btrim(initcap(replace(COALESCE(v_category, ''), '_', ' '))), '');
  v_loc := NULLIF(btrim(COALESCE(v_loc, '')), '');
  v_title := 'Support a tenant in a ' || COALESCE(v_category, 'Rental Home')
             || ' in ' || COALESCE(v_loc || ', Uganda', 'Uganda');
  v_desc := CASE WHEN v_rent > 0 THEN
      'Support this tenant for UGX ' || to_char(round(v_rent), 'FM999,999,999')
      || ' by paying their landlord on the platform and earn UGX '
      || to_char(round(v_rent * 0.15), 'FM999,999,999')
      || ' per month for the next 12 months Start here today.'
    ELSE
      'Support a tenant''s rent on Welile and earn monthly returns. Support today.'
    END;

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_images, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image, '') || '|' || COALESCE(v_title, '') || '|' || COALESCE(v_desc, ''));

  SELECT * INTO v_row FROM public.short_links s
  WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
  LIMIT 1;

  IF NOT FOUND THEN
    -- Legacy row for the same sharer/plan created before resource tagging.
    SELECT * INTO v_row FROM public.short_links s
    WHERE s.user_id = v_user
      AND s.resource_type IS NULL
      AND s.target_params->>'plan' = p_plan_id::text
    ORDER BY s.created_at
    LIMIT 1;
  END IF;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest,
        jsonb_build_object('plan', p_plan_id::text, 'ref', v_user::text),
        'rent_plan', p_plan_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      )
      RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent tap inserted first: return that persisted row.
      SELECT * INTO v_row FROM public.short_links s
      WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
      LIMIT 1;
    END;
  END IF;

  -- Refresh metadata in place only when it actually changed. The id, code and
  -- attribution are never modified.
  IF NOT v_created AND v_row.id IS NOT NULL
     AND COALESCE(v_row.og_image_fingerprint, '') <> v_fp THEN
    UPDATE public.short_links s
    SET resource_type = 'rent_plan',
        resource_id = p_plan_id,
        og_title = v_title,
        og_description = v_desc,
        og_image_url = v_image,
        og_image_fingerprint = v_fp,
        og_updated_at = now(),
        destination_path = COALESCE(s.destination_path, v_dest)
    WHERE s.id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$function$
;

-- public.public_house_support_offer(text)  (production md5 7760dfa1774fcdacee310934fd1d291b)
CREATE OR REPLACE FUNCTION public.public_house_support_offer(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT jsonb_build_object(
    'found', true,
    'share_code', s.code,
    'house_id', h.id,
    'title', COALESCE(NULLIF(btrim(h.title),''), initcap(replace(COALESCE(h.house_category,'Rental home'),'_',' '))),
    'house_category', h.house_category,
    'number_of_rooms', h.number_of_rooms,
    'village', h.village,
    'sub_county', h.sub_county,
    'district', h.district,
    'region', h.region,
    'monthly_rent', COALESCE(h.monthly_rent,0),
    'monthly_return', round(COALESCE(h.monthly_rent,0) * 0.15),
    'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
    'latitude', h.latitude,
    'longitude', h.longitude,
    'verified', COALESCE(h.verified,false),
    'shared_by', COALESCE(NULLIF(split_part(btrim(p.full_name), ' ', 1), ''), 'A Welile agent'),
    'availability', CASE
      WHEN EXISTS (SELECT 1 FROM public.partner_supported_houses ps
                    WHERE ps.house_id = h.id AND ps.status IN ('pending','active')) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                    WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled')) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status = 'reserved') THEN 'reserved'
      WHEN h.verified IS NOT TRUE OR h.status <> 'available' OR h.tenant_id IS NOT NULL
           OR COALESCE(h.is_hidden,false) = true OR COALESCE(h.monthly_rent,0) <= 0 THEN 'unavailable'
      ELSE 'available'
    END
  ) INTO v
  FROM public.short_links s
  JOIN public.house_listings h ON h.id = s.resource_id
  LEFT JOIN public.profiles p ON p.id = s.user_id
  WHERE s.code = p_code AND s.resource_type = 'house_support'
  LIMIT 1;

  RETURN COALESCE(v, jsonb_build_object('found', false));
END;
$function$
;

-- public.public_support_plan(uuid)  (production md5 84e8e991bd02ba2d13c0315b85a2fb54)
CREATE OR REPLACE FUNCTION public.public_support_plan(p_plan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan public.v_partner_self_fundable_plans%ROWTYPE;
  v_monthly numeric;
BEGIN
  -- Read-only public lookup for shared Support Plan links. Returns ONLY
  -- whitelisted safe fields: house photo, city/area, tenant first name,
  -- support amount, 15% monthly earning, 12-month total, funding status.
  -- Never returns phones, full names, IDs, GPS, agent or wallet data.
  SELECT p.*
  INTO v_plan
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id
    AND p.held_by IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  v_monthly := ROUND(COALESCE(v_plan.funding_amount, 0) * 0.15);

  RETURN jsonb_build_object(
    'status', 'available',
    'plan_id', v_plan.rent_request_id,
    'photo_url', CASE
      WHEN v_plan.house_image_urls IS NOT NULL AND array_length(v_plan.house_image_urls, 1) > 0
      THEN v_plan.house_image_urls[1]
      ELSE NULL
    END,
    'city', v_plan.request_city,
    'house_category', v_plan.house_category,
    'tenant_first_name', v_plan.tenant_first_name,
    'funding_amount', v_plan.funding_amount,
    'monthly_return', v_monthly,
    'twelve_month_total', v_monthly * 12
  );
END;
$function$
;

-- public.partner_supported_house_returns()  (production md5 ce1176237dea4005406c7e0434dce8f6)
CREATE OR REPLACE FUNCTION public.partner_supported_house_returns()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
  v_rows jsonb := '[]'::jsonb;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT lower(btrim(COALESCE(p.email, ''))), regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
    INTO v_email, v_phone
  FROM public.profiles p WHERE p.id = v_uid;

  WITH my_notes AS (
    SELECT n.*
    FROM public.promissory_notes n
    WHERE n.partner_user_id = v_uid
       OR (NULLIF(v_email, '') IS NOT NULL AND lower(btrim(COALESCE(n.email, ''))) = v_email)
       OR (
         NULLIF(v_phone, '') IS NOT NULL AND length(v_phone) >= 9 AND (
           right(regexp_replace(COALESCE(n.phone_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
           OR right(regexp_replace(COALESCE(n.whatsapp_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
         )
       )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'intent_id', i.id,
    'note_id', n.id,
    'house_id', h.id,
    'title', h.title,
    'district', h.district,
    'sub_county', h.sub_county,
    'village', h.village,
    'monthly_rent', COALESCE(i.monthly_rent, h.monthly_rent, 0),
    'monthly_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15),
    'annual_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15 * 12),
    'intent_status', i.status,
    'note_status', n.status,
    'promised_amount', COALESCE(n.amount, 0),
    'collected_amount', COALESCE(n.total_collected, 0),
    'is_funded', (n.status = 'activated' OR COALESCE(n.total_collected, 0) > 0),
    'tenant_activated', (h.tenant_id IS NOT NULL),
    'tenant_name', tp.full_name,
    'listing_agent_name', ap.full_name,
    'monthly_paid_this_month', EXISTS (
      SELECT 1 FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id
        AND pay.cfo_approved_at IS NOT NULL
        AND (pay.cfo_approved_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start
    ),
    'last_paid_at', (
      SELECT max(pay.cfo_approved_at) FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id AND pay.cfo_approved_at IS NOT NULL
    ),
    'created_at', i.created_at
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.promissory_note_house_intents i
  JOIN my_notes n ON n.id = i.note_id
  JOIN public.house_listings h ON h.id = i.house_id
  LEFT JOIN public.profiles tp ON tp.id = h.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = i.listing_agent_id;

  RETURN jsonb_build_object(
    'houses', v_rows,
    'total_monthly_return', COALESCE((SELECT SUM((x->>'monthly_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'total_annual_return', COALESCE((SELECT SUM((x->>'annual_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'house_count', jsonb_array_length(v_rows)
  );
END;
$function$
;

-- -------------------------------------------------------------------------------------------------------------------
-- E. Legacy rent facilitation: the reward is paid at the fixed 15% again; the stored rates are kept.
-- -------------------------------------------------------------------------------------------------------------------

-- public.post_rent_facilitation_reward(uuid, integer, uuid, text)  (production md5 3d4487b17add84f9cb1ab32d2ee34927)
CREATE OR REPLACE FUNCTION public.post_rent_facilitation_reward(p_rent_request_id uuid, p_payment_number integer, p_reinvest_portfolio_id uuid DEFAULT NULL::uuid, p_wallet_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rr record;
  pf record;
  v_now timestamptz := now();
  v_amount numeric;
  v_payment_id uuid;
  v_group uuid;
  v_key text := 'rent-reward:' || p_rent_request_id::text || ':' || p_payment_number::text;
  v_rent_txt text;
  v_new_principal numeric;
BEGIN
  -- One reward at a time per rent request.
  SELECT id, supporter_id, rent_amount, funded_at, status, next_roi_due_date, coalesce(total_roi_paid, 0) total_roi_paid,
         coalesce(roi_payments_count, 0) roi_payments_count
    INTO rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RENT_REWARD_NO_REQUEST: rent request % not found', p_rent_request_id USING ERRCODE = '22023'; END IF;

  -- Already done (by this or an earlier run): report, change nothing.
  IF p_payment_number <= rr.roi_payments_count THEN
    RETURN jsonb_build_object('status', 'already_posted', 'payment_number', p_payment_number);
  END IF;
  IF p_payment_number <> rr.roi_payments_count + 1 THEN
    RAISE EXCEPTION 'RENT_REWARD_STALE: expected payment % for rent request %, got %', rr.roi_payments_count + 1, p_rent_request_id, p_payment_number
      USING ERRCODE = '22023';
  END IF;
  -- A row for this payment number with the schedule not advanced: recorded by the old flow, posting unknown.
  -- Never post on top of it automatically; it appears in rent_reward_posting_gaps() for a CFO decision.
  IF EXISTS (SELECT 1 FROM public.supporter_roi_payments s WHERE s.rent_request_id = p_rent_request_id AND s.payment_number = p_payment_number) THEN
    RETURN jsonb_build_object('status', 'recorded_without_schedule', 'payment_number', p_payment_number);
  END IF;

  IF rr.supporter_id IS NULL OR rr.funded_at IS NULL OR rr.status NOT IN ('funded', 'disbursed', 'completed') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;
  IF (rr.next_roi_due_date IS NOT NULL AND rr.next_roi_due_date > v_now)
     OR (rr.next_roi_due_date IS NULL AND rr.funded_at + interval '30 days' > v_now) THEN
    RETURN jsonb_build_object('status', 'not_due', 'next_due', coalesce(rr.next_roi_due_date, rr.funded_at + interval '30 days'));
  END IF;

  v_amount := round(rr.rent_amount * 0.15);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'RENT_REWARD_AMOUNT: non-positive reward' USING ERRCODE = '22023'; END IF;
  v_rent_txt := to_char(rr.rent_amount, 'FM999,999,999,990');

  IF p_reinvest_portfolio_id IS NOT NULL THEN
    SELECT id, investor_id, status, investment_amount INTO pf FROM public.investor_portfolios WHERE id = p_reinvest_portfolio_id FOR UPDATE;
    IF NOT FOUND OR pf.investor_id IS DISTINCT FROM rr.supporter_id OR pf.status <> 'active' THEN
      RAISE EXCEPTION 'RENT_REWARD_REINVEST_TARGET_UNAVAILABLE: portfolio % is not an active portfolio of the supporter', p_reinvest_portfolio_id
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'reinvested')
    RETURNING id INTO v_payment_id;
    -- Raises PORTFOLIO_ON_HOLD for a held portfolio; the whole reward then rolls back.
    UPDATE public.investor_portfolios SET investment_amount = investment_amount + v_amount WHERE id = pf.id
    RETURNING investment_amount INTO v_new_principal;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('ROI payout #%s auto-reinvested into portfolio', p_payment_number), 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_reinvestment',
        'ledger_scope', 'platform', 'source_table', 'investor_portfolios', 'source_id', pf.id, 'linked_party', 'platform',
        'description', format('Auto-reinvested ROI #%s (%s) into portfolio', p_payment_number, to_char(v_amount, 'FM999,999,999,990')),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  ELSE
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'paid')
    RETURNING id INTO v_payment_id;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('Platform ROI payout #%s to supporter for rent facilitation of UGX %s', p_payment_number, v_rent_txt),
        'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_wallet_credit',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', coalesce(nullif(btrim(p_wallet_description), ''),
                                format('15%% monthly reward (payment #%s) on rent facilitation of UGX %s', p_payment_number, v_rent_txt)),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  END IF;

  UPDATE public.rent_requests
     SET next_roi_due_date = v_now + interval '30 days',
         total_roi_paid = rr.total_roi_paid + v_amount,
         roi_payments_count = p_payment_number
   WHERE id = rr.id;

  RETURN jsonb_build_object('status', 'posted', 'mode', CASE WHEN p_reinvest_portfolio_id IS NULL THEN 'wallet' ELSE 'reinvest' END,
    'payment_id', v_payment_id, 'payment_number', p_payment_number, 'amount', v_amount, 'transaction_group_id', v_group,
    'portfolio_id', p_reinvest_portfolio_id, 'previous_principal', CASE WHEN p_reinvest_portfolio_id IS NULL THEN NULL ELSE v_new_principal - v_amount END,
    'new_principal', v_new_principal);
END
$function$
;

-- -------------------------------------------------------------------------------------------------------------------
-- F. Monitoring: Phase 1's structural checks (verbatim from 20261108160000_partner_return_policy_phase1.sql).
-- -------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_partner_return_policy_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol   public.partner_return_policy%ROWTYPE;
  v_src   text;
  v_bad   integer;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;
  RETURN QUERY SELECT 'policy_row_exists', v_pol.id IS NOT NULL, 'partner_return_policy must hold exactly one row';

  RETURN QUERY SELECT 'gate_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_rate_policy' AND t.tgenabled <> 'D')
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'),
    'every new portfolio must pass the Partner Returns gate';

  RETURN QUERY SELECT 'rate_has_no_default',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
               AND c.column_name = 'roi_percentage' AND c.column_default IS NULL AND c.is_nullable = 'NO'),
    'the portfolio Returns rate must be required and have no default (the gate fills it)';

  RETURN QUERY SELECT 'decision_stamp_columns',
    (SELECT count(*) = 4 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
        AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at', 'rate_existing_at_decision')),
    'each portfolio must record the rate it was entitled to and why';

  RETURN QUERY SELECT 'note_rate_column',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'promissory_notes'
               AND c.column_name = 'return_rate' AND c.is_nullable = 'NO'),
    'each promissory note must record its Returns rate';

  RETURN QUERY SELECT 'note_triggers_enabled',
    (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
       AND t.tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate') AND t.tgenabled <> 'D'),
    'promissory notes must be stamped at insert and guarded on update';

  RETURN QUERY SELECT 'cutoff_guards_enabled',
    (SELECT count(*) = 4 FROM pg_trigger t
      WHERE t.tgname IN ('trg_partner_return_policy_guard', 'trg_partner_return_cohort_guard',
                         'trg_partner_return_note_windows_guard', 'trg_partner_return_legacy_guard') AND t.tgenabled <> 'D'),
    'the cut-off, the existing-partner list, the note windows and the legacy list must be protected';

  RETURN QUERY SELECT 'cutoff_set_when_enabled',
    (NOT COALESCE(v_pol.enabled, false))
      OR (v_pol.cutoff_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_return_cohort)),
    'with the switch on, the cut-off must be set and the existing-partner list filled';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'set_partner_return_policy' LIMIT 1;
  RETURN QUERY SELECT 'switch_ceo_only',
    v_src IS NOT NULL AND position('ARRAY[''ceo'']' in v_src) > 0
      AND v_src !~ 'ARRAY\[[^]]*''cfo''',
    'only the CEO may turn the switch on or off';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_portfolio_renewal' LIMIT 1;
  RETURN QUERY SELECT 'renewal_keeps_rate',
    v_src IS NOT NULL
      AND v_src !~* 'update\s+(public\.)?investor_portfolios(\s+(as\s+)?\w+)?\s+set\s+([^;]*?,\s*)?(\w+\.)?roi_percentage\s*=',
    'a renewal must keep the portfolio''s stored rate';

  SELECT count(*) INTO v_bad FROM public.partner_rate_conformance(NULL);
  RETURN QUERY SELECT 'rates_conform', v_bad = 0,
    v_bad || ' portfolio(s) since the cut-off have a Returns rate that does not match what they were entitled to (see partner_rate_conformance())';

  RETURN QUERY SELECT 'cron_jobs_scheduled',
    CASE WHEN to_regclass('cron.job') IS NULL THEN false
         ELSE (SELECT count(*) = 2 FROM cron.job j
                WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active) END,
    'the next-cycle job and the drift check must be scheduled';
END $function$;
REVOKE ALL ON FUNCTION public.assert_partner_return_policy_intact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_partner_return_policy_intact() TO service_role;

-- 3. Phase 2 triggers, then the Phase 2 functions (nothing restored above calls them).
DROP TRIGGER IF EXISTS trg_zz_partner_note_linked_late ON public.promissory_notes;
DROP TRIGGER IF EXISTS trg_zz_stamp_rent_reward_rate_ins ON public.rent_requests;
DROP TRIGGER IF EXISTS trg_zz_stamp_rent_reward_rate_upd ON public.rent_requests;

DROP FUNCTION IF EXISTS public.agent_create_promissory_notes_split(jsonb, uuid[]);
DROP FUNCTION IF EXISTS public.partner_quote_rate(text, uuid);
DROP FUNCTION IF EXISTS public._partner_commitment_follow_rate(uuid, numeric);
DROP FUNCTION IF EXISTS public.partner_rate_now(uuid);
DROP FUNCTION IF EXISTS public.partner_note_linked_late();
DROP FUNCTION IF EXISTS public.stamp_rent_facilitation_reward_rate();
DROP FUNCTION IF EXISTS public._promissory_note_rate_json(public.promissory_notes, uuid);
DROP FUNCTION IF EXISTS public._promissory_note_notice_contacts(public.promissory_notes);

-- 4. Not ready to switch on. Phase 2 never sets release_ready (the release migration does), so this normally changes
--    nothing; it clears the flag only if a later release left it set. Only a row that is still ready is changed, so a
--    second run writes nothing. The Phase 1 policy guard audits a change (audit_logs) and e-mails it; cutoff_at is
--    not touched.
UPDATE public.partner_return_policy
   SET release_ready = false,
       updated_by = NULL,
       updated_at = now(),
       note = concat_ws(' · ', NULLIF(btrim(note), ''),
                        'Phase 2 rolled back by the 20261108161000 rollback on '
                        || to_char(now() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI')
                        || ' (Kampala): not ready to switch on until Phase 2 and the release are re-applied')
 WHERE id AND release_ready AND NOT enabled;

-- 5. Check the result before committing; any failure aborts the whole rollback.
DO $verify$
DECLARE
  v_bad text[] := '{}';
  r     record;
  v_oid oid;
BEGIN
  -- 5a. Every restored function (22) is the production text, byte for byte.
  FOR r IN
    SELECT x.sig, x.md5, to_regprocedure(x.sig) AS fn
      FROM (VALUES
        ('public.funder_create_pending_portfolio(numeric,uuid,integer)', '6b938de2bbfe96a4f97d82672dbfac7d'),
        ('public.psm_confirm_commitment_for(uuid,uuid[],integer,text,uuid,uuid,text)', '44692e0de3e7b3ef9be44edb8e158b06'),
        ('public.partner_support_houses(uuid[],integer,text)', 'c7ffc8dcb0072f424382fd66b232b6bf'),
        ('public.partner_support_houses(uuid[],integer,text,uuid)', '8a91e283d2429e70c5da6e988cb90844'),
        ('public.countersign_prepare_support(uuid,numeric,text,text,uuid,boolean)', 'd700308d932151eb828ff4ebbab5815e'),
        ('public.get_countersign_summary(uuid,numeric)', 'd72f5a66332b4ab9ffb35c3ee037a423'),
        ('public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text)', '10094e3dafd79c145070c81c1f3ea5ec'),
        ('public.hr_pay_post_staff_reinvestment(uuid)', 'ed4cc123465f945d282e109f8770a22b'),
        ('public.agent_create_promissory_note(jsonb,uuid[])', '3fc2b24b3cfc9b37dabaa326d3771a97'),
        ('public.psm_queue_promissory_pledge_notice(uuid)', '18995fb13e5861b6393e9b5befacb4e7'),
        ('public.agent_create_promissory_note_for_houses(jsonb,uuid[])', 'c37cf13889aed93c5171c22361cd927c'),
        ('public.psm_queue_house_booking_notice(uuid,text)', '61efc5de32bd3597014c854224d60ed9'),
        ('public.enqueue_funder_house_notice(text,text,uuid,uuid,uuid,uuid,text,text,integer,numeric,numeric,text,timestamp with time zone,timestamp with time zone)', 'ddd9bc1a647be7ab23febd79eedb176b'),
        ('public.get_or_create_house_share_link(uuid)', '5fe498c42fc38723ac2719dcc524fb2b'),
        ('public.get_supporter_pool_stats()', 'a822072a8c929b24eedc9062fad47d67'),
        ('public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text)', 'af1b80d1581545b653bc5aae692b49b8'),
        ('public.empty_house_opportunity_summary()', '9bb8a0c9765d0ca5e020c733c1cb328b'),
        ('public.get_or_create_plan_share_link(uuid)', '23280e3466b2bcb20163a81a88a6adc9'),
        ('public.public_house_support_offer(text)', '7760dfa1774fcdacee310934fd1d291b'),
        ('public.public_support_plan(uuid)', '84e8e991bd02ba2d13c0315b85a2fb54'),
        ('public.partner_supported_house_returns()', 'ce1176237dea4005406c7e0434dce8f6'),
        ('public.post_rent_facilitation_reward(uuid,integer,uuid,text)', '3d4487b17add84f9cb1ab32d2ee34927')
      ) AS x(sig, md5)
  LOOP
    IF r.fn IS NULL THEN
      v_bad := v_bad || (r.sig || ' is missing');
    ELSIF md5(pg_get_functiondef(r.fn)) <> r.md5 THEN
      v_bad := v_bad || (r.sig || ' is not the production text (md5 ' || md5(pg_get_functiondef(r.fn))
                         || '; check client_encoding is UTF8 and the file has LF line endings)');
    END IF;
  END LOOP;

  -- 5b. The Phase 2 signatures, functions and triggers are gone.
  IF to_regprocedure('public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text,text,uuid)') IS NOT NULL THEN
    v_bad := v_bad || 'the Phase 2 agent_list_empty_house_opportunities signature still exists'::text;
  END IF;
  IF to_regprocedure('public.empty_house_opportunity_summary(text,uuid)') IS NOT NULL THEN
    v_bad := v_bad || 'the Phase 2 empty_house_opportunity_summary signature still exists'::text;
  END IF;
  FOR r IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('agent_create_promissory_notes_split', 'partner_quote_rate', '_partner_commitment_follow_rate',
                         'partner_rate_now', 'partner_note_linked_late', 'stamp_rent_facilitation_reward_rate',
                         '_promissory_note_rate_json', '_promissory_note_notice_contacts')
  LOOP
    v_bad := v_bad || (r.proname || ' still exists');
  END LOOP;
  FOR r IN
    SELECT t.tgname FROM pg_trigger t
     WHERE t.tgrelid IN ('public.promissory_notes'::regclass, 'public.rent_requests'::regclass)
       AND t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins',
                        'trg_zz_stamp_rent_reward_rate_upd')
  LOOP
    v_bad := v_bad || (r.tgname || ' still exists');
  END LOOP;

  -- 5c. The two re-created functions: production's owner and grants, compared as production's exact proacl text
  --     (entries and their order), not as a set.
  FOR r IN
    SELECT x.sig, to_regprocedure(x.sig) AS fn
      FROM (VALUES ('public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text)'),
                   ('public.empty_house_opportunity_summary()')) AS x(sig)
  LOOP
    CONTINUE WHEN r.fn IS NULL;                     -- reported by 5a
    IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = r.fn) IS DISTINCT FROM 'postgres'
       OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = r.fn)
          IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
      v_bad := v_bad || (r.sig || ' does not have the production owner and grants (owner '
                         || (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = r.fn) || ', proacl '
                         || COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = r.fn), 'default') || ')');
    END IF;
  END LOOP;

  -- 5d. Phase 1's monitoring checks, and not ready to switch on.
  v_oid := to_regprocedure('public.assert_partner_return_policy_intact()');
  IF v_oid IS NULL OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_oid) <> 'd8438632b5ad01f5942eb06bb4aace9a' THEN
    v_bad := v_bad || 'assert_partner_return_policy_intact is not the Phase 1 text'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_return_policy p WHERE p.id AND (p.release_ready OR p.enabled)) THEN
    v_bad := v_bad || 'partner_return_policy is still ready to switch on (or on)'::text;
  END IF;

  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'PHASE2_ROLLBACK_CHECK_FAILED (nothing was changed): %', array_to_string(v_bad, '; ')
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

COMMIT;
