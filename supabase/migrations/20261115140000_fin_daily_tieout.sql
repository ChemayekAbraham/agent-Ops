-- Nightly financial statements tie-out (CFO request, 11 Nov 2026). Reporting only: reads the ledger and operational
-- records through the existing statement functions, writes one history row per Kampala day, posts nothing, moves no
-- money and changes no balance.
--
-- Every night at 23:30 Kampala (20:30 UTC) fin_run_daily_tieout():
--   1. runs fin_balance_sheet(now())  -> every asset balance, Balance Sheet difference, trial balance difference and the
--      sub-ledger ties (Rent Plans, agent advances, Supporter capital, promissory notes, wallet custody, agent float);
--   2. runs fin_cash_flow(start of the Kampala day, now()) -> does closing cash equal the Balance Sheet cash;
--   3. compares the ties with the previous run and records any tie whose difference moved;
--   4. stores it in fin_daily_tieout with a status: ok, attention (Balance Sheet or trial balance out of balance, cash
--      flow not tying, or a tie difference moved since the previous run) or failed (a statement could not be built).
-- The statement functions require a signed-in finance user. A scheduled job has none, so - as the staff assistant's
-- scheduled runs do (20261026160000) - the run takes the identity set in fin_daily_tieout_settings.run_as (the CFO)
-- for its own transaction only and restores the previous identity afterwards. A finance user calling it directly runs
-- as themselves.
-- Rollback: supabase/rollbacks/20261115140000_fin_daily_tieout.rollback.sql

CREATE TABLE IF NOT EXISTS public.fin_daily_tieout_settings (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  run_as     uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  note       text
);
INSERT INTO public.fin_daily_tieout_settings (id, run_as, note)
VALUES (1, '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'CFO (Sarah Angwen), approved 11 Nov 2026')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.fin_daily_tieout (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date      date NOT NULL UNIQUE,                 -- Kampala day
  as_at         timestamptz NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('ok', 'attention', 'failed')),
  trigger       text NOT NULL DEFAULT 'cron',
  run_as        uuid,
  total_assets  numeric,
  bs_difference numeric,
  tb_difference numeric,
  assets        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- account code -> balance
  ties          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- fin_balance_sheet.subledger_ties
  cash_flow     jsonb,                                -- opening, closing, balance-sheet cash, ties, unexplained
  changes       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ties whose difference moved since the previous run
  error         text
);
COMMENT ON TABLE public.fin_daily_tieout IS
  'Nightly financial statements tie-out (one row per Kampala day): asset balances, sub-ledger ties, cash flow tie, and what changed since the previous run. Written only by fin_run_daily_tieout(). Reporting only.';

ALTER TABLE public.fin_daily_tieout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_daily_tieout_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_daily_tieout_read ON public.fin_daily_tieout;
CREATE POLICY fin_daily_tieout_read ON public.fin_daily_tieout FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS fin_daily_tieout_settings_read ON public.fin_daily_tieout_settings;
CREATE POLICY fin_daily_tieout_settings_read ON public.fin_daily_tieout_settings FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_daily_tieout;
CREATE POLICY mfa_required_for_staff ON public.fin_daily_tieout AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_daily_tieout_settings;
CREATE POLICY mfa_required_for_staff ON public.fin_daily_tieout_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.fin_daily_tieout, public.fin_daily_tieout_settings FROM anon, authenticated;
GRANT SELECT ON public.fin_daily_tieout, public.fin_daily_tieout_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_daily_tieout, public.fin_daily_tieout_settings TO service_role;

CREATE OR REPLACE FUNCTION public.fin_run_daily_tieout(p_trigger text DEFAULT 'cron')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15min'
AS $function$
DECLARE
  v_caller      uuid := auth.uid();
  v_run_as      uuid;
  v_prev_sub    text := current_setting('request.jwt.claim.sub', true);
  v_prev_role   text := current_setting('request.jwt.claim.role', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_as_at       timestamptz := now();
  v_day         date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start   timestamptz := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_bs          jsonb;
  v_cf          jsonb;
  v_err         text;
  v_assets      jsonb := '{}'::jsonb;
  v_prev        record;
  v_changes     jsonb := '[]'::jsonb;
  v_status      text;
  v_id          uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    -- a signed-in finance user runs it as themselves
    IF NOT public._fin_can_view() THEN RAISE EXCEPTION 'Not authorised to run the tie-out'; END IF;
    v_run_as := v_caller;
  ELSE
    SELECT run_as INTO v_run_as FROM public.fin_daily_tieout_settings WHERE id = 1;
    IF v_run_as IS NULL THEN RAISE EXCEPTION 'fin_daily_tieout_settings.run_as is not set'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_run_as::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', v_run_as::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  END IF;

  BEGIN
    v_bs := public.fin_balance_sheet(v_as_at);
  EXCEPTION WHEN OTHERS THEN
    v_err := 'Balance Sheet: ' || SQLERRM;
  END;
  BEGIN
    v_cf := public.fin_cash_flow(v_day_start, v_as_at);
  EXCEPTION WHEN OTHERS THEN
    v_err := concat_ws(' | ', v_err, 'Cash flow: ' || SQLERRM);
  END;

  IF v_caller IS NULL THEN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_role, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
  END IF;

  IF v_bs IS NOT NULL THEN
    SELECT COALESCE(jsonb_object_agg(substring(e->>'source' from 'account\s+([A-Z][0-9]+)\s*$'), (e->>'value')::numeric), '{}'::jsonb)
      INTO v_assets
      FROM jsonb_array_elements(COALESCE(v_bs->'assets'->'current', '[]'::jsonb) || COALESCE(v_bs->'assets'->'non_current', '[]'::jsonb)) e
     WHERE substring(e->>'source' from 'account\s+([A-Z][0-9]+)\s*$') IS NOT NULL;
  END IF;

  -- ties whose difference moved since the previous run
  SELECT * INTO v_prev FROM public.fin_daily_tieout
   WHERE run_date < v_day AND status <> 'failed' ORDER BY run_date DESC LIMIT 1;
  IF v_bs IS NOT NULL AND v_prev.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'key', t->>'key', 'label', t->>'label',
             'previous', (p->>'difference')::numeric, 'current', (t->>'difference')::numeric,
             'moved_by', round((t->>'difference')::numeric - COALESCE((p->>'difference')::numeric, 0)))), '[]'::jsonb)
      INTO v_changes
      FROM jsonb_array_elements(COALESCE(v_bs->'subledger_ties', '[]'::jsonb)) t
      LEFT JOIN jsonb_array_elements(v_prev.ties) p ON p->>'key' = t->>'key'
     WHERE abs(round((t->>'difference')::numeric) - round(COALESCE((p->>'difference')::numeric, 0))) >= 1;
  END IF;

  v_status := CASE
    WHEN v_bs IS NULL OR v_cf IS NULL THEN 'failed'
    WHEN abs(COALESCE((v_bs->'balance_check'->>'difference')::numeric, 0)) >= 1
      OR abs(COALESCE((v_bs->'trial_balance'->>'difference')::numeric, 0)) >= 1
      OR COALESCE((v_cf->>'ties_to_balance_sheet')::boolean, false) = false
      OR jsonb_array_length(v_changes) > 0 THEN 'attention'
    ELSE 'ok' END;

  INSERT INTO public.fin_daily_tieout AS d (run_date, as_at, finished_at, status, trigger, run_as, total_assets,
      bs_difference, tb_difference, assets, ties, cash_flow, changes, error)
  VALUES (v_day, v_as_at, clock_timestamp(), v_status, COALESCE(p_trigger, 'cron'), v_run_as,
      (v_bs->'assets'->>'total')::numeric,
      (v_bs->'balance_check'->>'difference')::numeric,
      (v_bs->'trial_balance'->>'difference')::numeric,
      v_assets, COALESCE(v_bs->'subledger_ties', '[]'::jsonb),
      CASE WHEN v_cf IS NULL THEN NULL ELSE jsonb_build_object(
        'from', v_day_start, 'opening', v_cf->'opening_cash', 'closing', v_cf->'closing_cash',
        'balance_sheet_cash', v_cf->'balance_sheet_cash', 'ties', v_cf->'ties_to_balance_sheet',
        'unexplained', v_cf->'unexplained_difference') END,
      v_changes, v_err)
  ON CONFLICT (run_date) DO UPDATE SET
      as_at = EXCLUDED.as_at, started_at = clock_timestamp(), finished_at = EXCLUDED.finished_at, status = EXCLUDED.status,
      trigger = EXCLUDED.trigger, run_as = EXCLUDED.run_as, total_assets = EXCLUDED.total_assets,
      bs_difference = EXCLUDED.bs_difference, tb_difference = EXCLUDED.tb_difference, assets = EXCLUDED.assets,
      ties = EXCLUDED.ties, cash_flow = EXCLUDED.cash_flow, changes = EXCLUDED.changes, error = EXCLUDED.error
  RETURNING d.id INTO v_id;
  RETURN v_id;
END;
$function$;
COMMENT ON FUNCTION public.fin_run_daily_tieout(text) IS
  'Nightly financial statements tie-out: Balance Sheet, sub-ledger ties and cash flow tie into fin_daily_tieout. Reporting only.';
REVOKE ALL ON FUNCTION public.fin_run_daily_tieout(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_run_daily_tieout(text) TO service_role;

-- 23:30 Kampala = 20:30 UTC
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fin-daily-tieout';
    PERFORM cron.schedule('fin-daily-tieout', '30 20 * * *', $cron$SELECT public.fin_run_daily_tieout('cron');$cron$);
  END IF;
END
$do$;
