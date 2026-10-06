-- Landlord Float Pool: older (pre-cutover) portfolios JOIN the pool's money flows.
--
-- Plan: docs/LEGACY_PORTFOLIOS_POOL_JOIN_PLAN.md (J1–J5 approved 2026-10-06):
--   J1 older portfolios join with a ZERO starting balance (principal not moved in);
--   J2 top-ups AND compounding go into the pool from the join time;
--   J3 a principal drop releases least(drop, that portfolio's pool money), newest first;
--      closing (redeemed / cancelled / rejected) releases everything;
--   J4 optional ceiling on older-portfolio pool money, OFF by default;
--   J5 join run: 20:00 EAT on 7 Oct 2026, one-shot pg_cron job.
--
-- Design:
-- * Membership lives in its own table (landlord_pool_legacy_members), not on
--   investor_portfolios: no DDL on that hot table, and pool_eligible keeps its
--   meaning ("principal was reserved at creation").
-- * Every money step that used to require pool_eligible now requires
--   pool_eligible OR membership (landlord_pool_is_member). New-portfolio
--   behaviour is unchanged.
-- * No new ledger categories: older-portfolio money uses the existing
--   landlord_pool_{topup|compound|release}_<origin> + reserve_source/release_target.
-- * House claiming (allocate_company_managed_portfolio) stays pool_eligible-only.
--
-- Requires 20261006150000 (category tags) — the join run refuses to start unless
-- that run succeeded.

-- 1. Switch rows -----------------------------------------------------------------

INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('landlord_pool_legacy_from', false, NULL),
       ('landlord_pool_legacy_ceiling', false, NULL)
ON CONFLICT (control_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.landlord_pool_legacy_from()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN tc.enabled AND NULLIF(tc.value, '') IS NOT NULL
              THEN tc.value::timestamptz END
    FROM public.treasury_controls tc
   WHERE tc.control_key = 'landlord_pool_legacy_from';
$$;

-- 2. Membership ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.landlord_pool_legacy_members (
  portfolio_id uuid PRIMARY KEY REFERENCES public.investor_portfolios(id),
  joined_at    timestamptz NOT NULL,
  run_id       uuid,
  origin       text NOT NULL CHECK (origin IN ('self_support', 'company_managed')),
  status_at_join    text,
  principal_at_join numeric,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Membership is permanent: rows can be added, never changed or removed
-- (undo = switch landlord_pool_legacy_from off).
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_legacy_members_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'LANDLORD_POOL_LEGACY_MEMBERSHIP_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_pool_legacy_members_immutable ON public.landlord_pool_legacy_members;
CREATE TRIGGER trg_landlord_pool_legacy_members_immutable
  BEFORE UPDATE OR DELETE ON public.landlord_pool_legacy_members
  FOR EACH ROW EXECUTE FUNCTION public.trg_landlord_pool_legacy_members_immutable();

ALTER TABLE public.landlord_pool_legacy_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landlord_pool_legacy_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.landlord_pool_legacy_members TO service_role;

-- Ceiling skips: the part of a top-up / compound that the ceiling kept out.
CREATE TABLE IF NOT EXISTS public.landlord_pool_legacy_skips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id   uuid NOT NULL REFERENCES public.investor_portfolios(id),
  kind           text NOT NULL CHECK (kind IN ('topup', 'compound')),
  event_amount   numeric NOT NULL,
  skipped_amount numeric NOT NULL CHECK (skipped_amount > 0),
  source_table   text NOT NULL,
  source_id      uuid NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);
ALTER TABLE public.landlord_pool_legacy_skips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landlord_pool_legacy_skips FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.landlord_pool_legacy_skips TO service_role;

-- True when the portfolio follows pool rules right now.
CREATE OR REPLACE FUNCTION public.landlord_pool_is_member(p_portfolio_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.investor_portfolios
                  WHERE id = p_portfolio_id AND pool_eligible)
      OR (public.landlord_pool_legacy_from() IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.landlord_pool_legacy_members m
                       WHERE m.portfolio_id = p_portfolio_id AND m.joined_at <= now()));
$$;

-- 3. Top-up / compounding reserve (J2, J4) -----------------------------------------

CREATE OR REPLACE FUNCTION public.landlord_pool_reserve_increment(p_portfolio_id uuid, p_kind text, p_amount numeric, p_source_table text, p_source_id uuid, p_caller text DEFAULT 'unknown'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p        public.investor_portfolios%ROWTYPE;
  v_src    text;
  v_origin text;
  v_group  uuid;
  v_entry  uuid;
  v_legacy boolean := false;
  v_amount numeric := p_amount;
  v_ceiling numeric;
  v_room   numeric;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;
  IF p_kind NOT IN ('topup', 'compound') THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INVALID_INCREMENT' USING HINT = coalesce(p_kind, 'null');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('status', 'no_op'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_portfolio'); END IF;
  IF NOT p.pool_eligible THEN
    IF NOT public.landlord_pool_is_member(p.id) THEN
      RETURN jsonb_build_object('status', 'pre_cutover');
    END IF;
    v_legacy := true;
  END IF;
  IF p.status IN ('redeemed', 'cancelled', 'rejected') THEN
    RETURN jsonb_build_object('status', 'closed', 'portfolio_status', p.status);
  END IF;

  IF EXISTS (SELECT 1 FROM public.landlord_pool_entries
              WHERE source_table = p_source_table AND source_id = p_source_id)
     OR EXISTS (SELECT 1 FROM public.landlord_pool_legacy_skips
                 WHERE source_table = p_source_table AND source_id = p_source_id) THEN
    RETURN jsonb_build_object('status', 'already_reserved');
  END IF;

  IF p_source_table = 'partner_self_funding_lines' THEN
    v_origin := 'self_support';
  ELSE
    SELECT fp.source INTO v_src FROM public.funder_pending_portfolios fp
     WHERE fp.portfolio_id = p.id ORDER BY fp.created_at DESC LIMIT 1;
    v_origin := coalesce(p.pool_origin,
                         CASE WHEN v_src IN ('self_managed', 'self_managed_house') THEN 'self_support'
                              ELSE 'company_managed' END);
  END IF;

  -- J4: optional ceiling on older-portfolio pool money (off by default).
  IF v_legacy THEN
    SELECT CASE WHEN tc.enabled AND NULLIF(tc.value, '') IS NOT NULL THEN tc.value::numeric END
      INTO v_ceiling
      FROM public.treasury_controls tc WHERE tc.control_key = 'landlord_pool_legacy_ceiling';
    IF v_ceiling IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('landlord_pool_legacy_ceiling'));
      SELECT v_ceiling - coalesce(sum(e.in_pool), 0) INTO v_room
        FROM public.landlord_pool_entries e
        JOIN public.landlord_pool_legacy_members m ON m.portfolio_id = e.portfolio_id;
      v_amount := least(p_amount, greatest(v_room, 0));
      IF v_amount < p_amount THEN
        INSERT INTO public.landlord_pool_legacy_skips
          (portfolio_id, kind, event_amount, skipped_amount, source_table, source_id, reason)
        VALUES (p.id, p_kind, p_amount, p_amount - v_amount, p_source_table, p_source_id,
                format('ceiling %s reached', v_ceiling))
        ON CONFLICT (source_table, source_id) DO NOTHING;
      END IF;
      IF v_amount <= 0 THEN
        RETURN jsonb_build_object('status', 'ceiling_skipped', 'kind', p_kind, 'skipped', p_amount);
      END IF;
    END IF;
  END IF;

  v_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_' || p_kind || '_' || v_origin,
        'direction', 'cash_in', 'amount', v_amount, 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p.portfolio_code,
        'linked_party', p.investor_id::text,
        'description', format('Landlord Float Pool %s (%s) — portfolio %s%s',
                              CASE p_kind WHEN 'topup' THEN 'top-up' ELSE 'compounded Returns' END,
                              replace(v_origin, '_', '-'), p.portfolio_code,
                              CASE WHEN v_legacy THEN ' (joined older portfolio)' ELSE '' END)),
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_reserve_source',
        'direction', 'cash_out', 'amount', v_amount, 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p.portfolio_code,
        'linked_party', p.investor_id::text,
        'description', format('Treasury cash reserved into the Landlord Float Pool (%s) — portfolio %s',
                              CASE p_kind WHEN 'topup' THEN 'top-up' ELSE 'compounded Returns' END, p.portfolio_code))),
    idempotency_key := 'lp-' || p_kind || '-' || p_source_table || '-' || p_source_id::text);

  INSERT INTO public.landlord_pool_entries
    (portfolio_id, partner_id, origin, source_table, source_id, principal, reserve_group_id, entry_kind)
  VALUES (p.id, p.investor_id, v_origin, p_source_table, p_source_id, v_amount, v_group, p_kind)
  ON CONFLICT (source_table, source_id) DO NOTHING
  RETURNING id INTO v_entry;

  IF v_entry IS NOT NULL THEN
    INSERT INTO public.landlord_pool_movements (pool_entry_id, kind, amount, ledger_group_id, created_by)
    VALUES (v_entry, 'reserve', v_amount, v_group, auth.uid())
    ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'kind', p_kind, 'origin', v_origin,
                            'amount', v_amount, 'skipped', p_amount - v_amount, 'legacy', v_legacy,
                            'entry_id', v_entry, 'caller', p_caller);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_landlord_pool_increment_on_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pid  uuid;
  v_kind text;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;
  IF NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL THEN RETURN NULL; END IF;

  IF NEW.category = 'roi_reinvestment' AND NEW.direction = 'cash_in' THEN
    v_kind := 'compound';
  ELSIF NEW.category = 'pending_portfolio_topup' AND NEW.direction = 'cash_out'
        AND NEW.transaction_group_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.general_ledger g
                     WHERE g.transaction_group_id = NEW.transaction_group_id
                       AND g.ledger_scope = 'platform' AND g.category = 'partner_funding'
                       AND g.direction = 'cash_in') THEN
    v_kind := 'topup';
  ELSE
    RETURN NULL;
  END IF;

  v_pid := NEW.source_id::uuid;
  IF NOT public.landlord_pool_is_member(v_pid) THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM public.landlord_pool_reserve_increment(v_pid, v_kind, NEW.amount, 'general_ledger', NEW.id,
                                                   'ledger:' || NEW.category);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (v_pid, 'reserve', 'ledger:' || NEW.category, SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'kind', v_kind, 'ledger_leg_id', NEW.id,
                               'transaction_group_id', NEW.transaction_group_id, 'amount', NEW.amount));
  END;
  RETURN NULL;
END;
$function$;

-- 4. Release for joined older portfolios (J3) ----------------------------------------

CREATE OR REPLACE FUNCTION public.landlord_pool_legacy_release(p_portfolio_id uuid, p_amount numeric, p_caller text DEFAULT 'unknown'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p        public.investor_portfolios%ROWTYPE;
  v_left   numeric := p_amount;
  v_take   numeric;
  v_ref    text := gen_random_uuid()::text;
  v_out    jsonb := '[]'::jsonb;
  r        record;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('status', 'no_op'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_portfolio'); END IF;

  FOR r IN
    SELECT id, in_pool FROM public.landlord_pool_entries
     WHERE portfolio_id = p.id AND in_pool > 0
     ORDER BY created_at DESC, id DESC
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0.5;
    v_take := least(v_left, r.in_pool);
    PERFORM public._landlord_pool_post(r.id, 'release', v_take, v_ref, NULL, NULL, NULL,
      format('Landlord Float Pool release — older portfolio %s, principal reduced (%s)', p.portfolio_code, p_caller));
    v_left := v_left - v_take;
    v_out := v_out || jsonb_build_object('entry_id', r.id, 'amount', v_take);
  END LOOP;

  RETURN jsonb_build_object('status', CASE WHEN jsonb_array_length(v_out) = 0 THEN 'nothing_in_pool' ELSE 'released' END,
                            'released', p_amount - greatest(v_left, 0), 'draws', v_out, 'caller', p_caller);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_landlord_pool_release_on_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_closed boolean;
BEGIN
  IF NOT (coalesce(NEW.investment_amount, 0) < coalesce(OLD.investment_amount, 0)
          OR (NEW.status IN ('redeemed', 'cancelled', 'rejected')
              AND OLD.status IS DISTINCT FROM NEW.status)) THEN
    RETURN NULL;
  END IF;
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;
  IF NOT NEW.pool_eligible AND NOT public.landlord_pool_is_member(NEW.id) THEN RETURN NULL; END IF;

  v_closed := NEW.status IN ('redeemed', 'cancelled', 'rejected');

  BEGIN
    IF NEW.pool_eligible OR v_closed THEN
      -- New portfolios: unchanged. Closing any member: rebalance releases everything.
      PERFORM public.landlord_pool_rebalance(NEW.id, 'portfolio_change');
    ELSE
      -- Joined older portfolio, principal reduced: release least(drop, its pool money).
      PERFORM public.landlord_pool_legacy_release(NEW.id,
        coalesce(OLD.investment_amount, 0) - coalesce(NEW.investment_amount, 0), 'portfolio_change');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NEW.id, 'release', 'portfolio_change', SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'old_status', OLD.status, 'new_status', NEW.status,
                               'old_amount', OLD.investment_amount, 'new_amount', NEW.investment_amount,
                               'legacy', NOT NEW.pool_eligible));
  END;
  RETURN NULL;
END;
$function$;

-- 5. Controls and report -------------------------------------------------------------

-- A top-up / compounding event on a joined older portfolio, after it joined,
-- with neither a pool entry nor a ceiling skip. MUST be empty.
CREATE OR REPLACE VIEW public.v_landlord_pool_legacy_missed
WITH (security_invoker = true) AS
SELECT gl.id AS ledger_leg_id, gl.created_at, gl.category, gl.amount,
       m.portfolio_id, ip.portfolio_code, ip.status
  FROM public.general_ledger gl
  JOIN public.landlord_pool_legacy_members m ON m.portfolio_id::text = gl.source_id::text
  JOIN public.investor_portfolios ip ON ip.id = m.portfolio_id
 WHERE public.landlord_pool_legacy_from() IS NOT NULL
   AND gl.created_at >= m.joined_at
   AND gl.ledger_scope = 'platform'
   AND gl.source_table = 'investor_portfolios'
   AND ip.status NOT IN ('redeemed', 'cancelled', 'rejected')
   AND ((gl.category = 'roi_reinvestment' AND gl.direction = 'cash_in')
        OR (gl.category = 'pending_portfolio_topup' AND gl.direction = 'cash_out'
            AND EXISTS (SELECT 1 FROM public.general_ledger g
                         WHERE g.transaction_group_id = gl.transaction_group_id
                           AND g.ledger_scope = 'platform' AND g.category = 'partner_funding'
                           AND g.direction = 'cash_in')))
   AND NOT EXISTS (SELECT 1 FROM public.landlord_pool_entries e
                    WHERE e.source_table = 'general_ledger' AND e.source_id = gl.id)
   AND NOT EXISTS (SELECT 1 FROM public.landlord_pool_legacy_skips s
                    WHERE s.source_table = 'general_ledger' AND s.source_id = gl.id);

REVOKE ALL ON public.v_landlord_pool_legacy_missed FROM PUBLIC, anon;
GRANT SELECT ON public.v_landlord_pool_legacy_missed TO authenticated, service_role;

-- Report: add "joined" to the per-portfolio category view.
CREATE OR REPLACE VIEW public.v_portfolio_pool_category
WITH (security_invoker = true) AS
SELECT ip.id                 AS portfolio_id,
       ip.portfolio_code,
       ip.investor_id        AS partner_id,
       ip.status,
       ip.pool_origin        AS category,
       ip.pool_eligible,
       (e.portfolio_id IS NOT NULL) AS cash_in_pool,
       ip.investment_amount  AS live_principal,
       coalesce(e.reserved, 0)         AS pool_reserved,
       coalesce(e.in_pool, 0)          AS pool_in_pool,
       coalesce(e.out_with_tenants, 0) AS pool_out_with_tenants,
       coalesce(e.released, 0)         AS pool_released,
       m.joined_at           AS legacy_joined_at
  FROM public.investor_portfolios ip
  LEFT JOIN (
    SELECT portfolio_id,
           sum(principal) AS reserved, sum(in_pool) AS in_pool,
           sum(out_with_tenants) AS out_with_tenants, sum(released) AS released
      FROM public.landlord_pool_entries
     WHERE portfolio_id IS NOT NULL
     GROUP BY 1
  ) e ON e.portfolio_id = ip.id
  LEFT JOIN public.landlord_pool_legacy_members m ON m.portfolio_id = ip.id;

REVOKE ALL ON public.v_portfolio_pool_category FROM PUBLIC, anon;
GRANT SELECT ON public.v_portfolio_pool_category TO authenticated, service_role;

-- 6. The join run (J5) -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.landlord_pool_legacy_join_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz,
  mode            text NOT NULL CHECK (mode IN ('live', 'dry_run')),
  status          text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'expired', 'blocked')),
  members_added   integer,
  before_snapshot jsonb,
  after_snapshot  jsonb,
  error           text
);
ALTER TABLE public.landlord_pool_legacy_join_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landlord_pool_legacy_join_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.landlord_pool_legacy_join_runs TO service_role;

CREATE OR REPLACE FUNCTION public.landlord_pool_join_legacy_portfolios(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c_job        constant text := 'landlord-pool-legacy-join-once';
  c_window_end constant timestamptz := '2026-10-07 18:00:00+00';  -- 21:00 EAT
  v_mode   text := CASE WHEN p_dry_run THEN 'dry_run' ELSE 'live' END;
  v_run    uuid := gen_random_uuid();
  v_before jsonb;
  v_after  jsonb;
  v_n      integer;
  v_target integer;
  v_gl     integer;
  v_mv     integer;
  v_ex     integer;
  v_pa     integer;
  v_err    text;
BEGIN
  IF NOT p_dry_run AND EXISTS (SELECT 1 FROM landlord_pool_legacy_join_runs
                                WHERE mode = 'live' AND status = 'succeeded') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
    INSERT INTO landlord_pool_legacy_join_runs (id, mode, status, finished_at, error)
    VALUES (v_run, v_mode, 'skipped', clock_timestamp(), 'already succeeded');
    RETURN jsonb_build_object('status', 'skipped');
  END IF;

  IF NOT p_dry_run AND now() > c_window_end THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
    INSERT INTO landlord_pool_legacy_join_runs (id, mode, status, finished_at, error)
    VALUES (v_run, v_mode, 'expired', clock_timestamp(), 'outside the scheduled window');
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  -- The category tags must be in place first (live run only; a dry run may
  -- simulate the tags itself).
  IF NOT p_dry_run AND NOT EXISTS (SELECT 1 FROM landlord_pool_legacy_category_runs
                                    WHERE mode = 'live' AND status = 'succeeded') THEN
    INSERT INTO landlord_pool_legacy_join_runs (id, mode, status, finished_at, error)
    VALUES (v_run, v_mode, 'blocked', clock_timestamp(), 'category run has not succeeded');
    RETURN jsonb_build_object('status', 'blocked');
  END IF;

  BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    v_before := _landlord_pool_legacy_snapshot();
    INSERT INTO landlord_pool_legacy_join_runs (id, mode, status, before_snapshot)
    VALUES (v_run, v_mode, 'failed', v_before);

    -- Older portfolios that are running: active or locked, not split children.
    SELECT count(*) INTO v_target
      FROM investor_portfolios ip
     WHERE NOT ip.pool_eligible AND ip.pool_origin IS NOT NULL
       AND ip.status IN ('active', 'locked') AND ip.locked_from_portfolio_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM landlord_pool_legacy_members m WHERE m.portfolio_id = ip.id);

    INSERT INTO landlord_pool_legacy_members
      (portfolio_id, joined_at, run_id, origin, status_at_join, principal_at_join)
    SELECT ip.id, now(), v_run, ip.pool_origin, ip.status, ip.investment_amount
      FROM investor_portfolios ip
     WHERE NOT ip.pool_eligible AND ip.pool_origin IS NOT NULL
       AND ip.status IN ('active', 'locked') AND ip.locked_from_portfolio_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM landlord_pool_legacy_members m WHERE m.portfolio_id = ip.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;

    -- Switch on: from now, their top-ups / compounding / principal drops act on the pool.
    UPDATE treasury_controls SET enabled = true, value = now()::text, updated_at = now()
     WHERE control_key = 'landlord_pool_legacy_from';

    v_after := _landlord_pool_legacy_snapshot();

    SELECT count(*) INTO v_gl FROM general_ledger           WHERE created_at = now();
    SELECT count(*) INTO v_mv FROM landlord_pool_movements  WHERE created_at = now();
    SELECT count(*) INTO v_ex FROM landlord_pool_exceptions WHERE created_at = now();
    SELECT count(*) INTO v_pa FROM portfolio_allocations    WHERE created_at = now();

    IF v_gl <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % ledger rows written', v_gl; END IF;
    IF v_mv <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % pool movements written', v_mv; END IF;
    IF v_ex <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % pool exceptions written', v_ex; END IF;
    IF v_pa <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % house claims written', v_pa; END IF;
    IF v_n <> v_target OR v_n = 0 THEN
      RAISE EXCEPTION 'CHECK_FAILED: members added % vs target %', v_n, v_target;
    END IF;
    IF public.landlord_pool_legacy_from() IS NULL THEN RAISE EXCEPTION 'CHECK_FAILED: switch not on'; END IF;
    IF (v_after->>'tie_diff_self_support')::numeric <> (v_before->>'tie_diff_self_support')::numeric
       OR (v_after->>'tie_diff_company_managed')::numeric <> (v_before->>'tie_diff_company_managed')::numeric THEN
      RAISE EXCEPTION 'CHECK_FAILED: books vs pool records moved';
    END IF;

    UPDATE landlord_pool_legacy_join_runs
       SET status = 'succeeded', finished_at = clock_timestamp(), members_added = v_n, after_snapshot = v_after
     WHERE id = v_run;

    IF p_dry_run THEN RAISE EXCEPTION 'DRY_RUN_ROLLBACK'; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    INSERT INTO landlord_pool_legacy_join_runs
      (id, mode, status, finished_at, members_added, before_snapshot, after_snapshot, error)
    VALUES (v_run, v_mode,
            CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'succeeded' ELSE 'failed' END,
            clock_timestamp(), v_n, v_before, v_after,
            CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'dry run: rolled back' ELSE v_err END);
    RETURN jsonb_build_object('status', CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'dry_run_ok' ELSE 'failed' END,
                              'run_id', v_run, 'members', v_n, 'target', v_target, 'error', v_err);
  END;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
  RETURN jsonb_build_object('status', 'succeeded', 'run_id', v_run, 'members', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_pool_legacy_from() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_is_member(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_reserve_increment(uuid, text, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_legacy_release(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_join_legacy_portfolios(boolean) FROM PUBLIC, anon, authenticated;
-- Read-only switch; the security_invoker control view calls it as the viewer.
GRANT EXECUTE ON FUNCTION public.landlord_pool_legacy_from() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_is_member(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_reserve_increment(uuid, text, numeric, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_legacy_release(uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_join_legacy_portfolios(boolean) TO service_role;

-- 7. Schedule: 20:00 EAT on 7 Oct 2026, retry every 5 min to 20:55 ----------------------

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'landlord-pool-legacy-join-once';
SELECT cron.schedule(
  'landlord-pool-legacy-join-once',
  '0-55/5 17 7 10 *',
  $cron$ SELECT public.landlord_pool_join_legacy_portfolios(false); $cron$
);
