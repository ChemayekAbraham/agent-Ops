-- Phase 6 fix round (F1, F2, F4; decider signature and grants; conformance; F5 cron pins), unit level. Run by
-- run_phase4_tests.sh phase6 on a FRESH load (switch never on), owner session. THROWAWAY local Postgres only.
--   F1  existing partners who are also staff keep their own rate: rate_existing_at_decision stamped by the gate on every
--       switch-on insert with an investor (salary reinvestment and invite claims too), NULL while off / carried, never
--       changed afterwards; partner_rates_for counts a live portfolio (or its carve-out chain) stamped true as continuing.
--   F2  the late link takes the rate lock only for people whose linked note has an OPEN pre-cut-off window.
--   F4  an invite opened while on (new_no_investor) and claimed while off is re-stamped legacy (switch_off).
--   F5  cron schedules off the payout windows: 16:15 and minutes 1,11,...,51.
-- (Written from the fixer's smoke, scratchpad p6fix/sql/smoke_f1f2f4.sql, 24 checks.)
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
CREATE TEMP TABLE r (k text, got text, want text);
CREATE FUNCTION pg_temp.ck(k text, got text, want text) RETURNS void LANGUAGE sql AS $$ INSERT INTO r VALUES (k, got, want) $$;
CREATE FUNCTION pg_temp.u(c text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-0000-0000-0000000000' || c)::uuid $$;
CREATE FUNCTION pg_temp.rf(c text) RETURNS text LANGUAGE sql AS $$
  SELECT trim_scale(x.rate) || '|' || x.basis || '|' || x.existing FROM public.partner_rates_for(ARRAY[pg_temp.u(c)]) x $$;
CREATE FUNCTION pg_temp.pf(code text) RETURNS text LANGUAGE sql AS $$
  SELECT trim_scale(roi_percentage) || '|' || rate_basis || '|' || COALESCE(rate_existing_at_decision::text, 'null')
    FROM public.investor_portfolios WHERE portfolio_code = code $$;
CREATE FUNCTION pg_temp.advisory() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid::int = hashtext('partner-rate') $$;

-- Signature and grants of the decider (unchanged apart from the extra column).
SELECT pg_temp.ck('decider.sig', pg_get_function_result('public.partner_rates_for(uuid[],boolean)'::regprocedure)
  || ' / ' || (SELECT proacl::text FROM pg_proc WHERE oid = 'public.partner_rates_for(uuid[],boolean)'::regprocedure)
  || ' / auth=' || has_function_privilege('authenticated', 'public.partner_rates_for(uuid[],boolean)', 'EXECUTE')
  || ' anon=' || has_function_privilege('anon', 'public.partner_rates_for(uuid[],boolean)', 'EXECUTE'),
  'TABLE(partner_id uuid, rate numeric, basis text, existing boolean) / {postgres=X/postgres,service_role=X/postgres} / auth=false anon=false');
SELECT pg_temp.ck('decider.old1arg', (to_regprocedure('public.partner_rates_for(uuid[])') IS NULL)::text, 'true');
SELECT pg_temp.ck('gate.cols', (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_trigger t JOIN pg_attribute a
   ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::int2[]) WHERE t.tgname = 'trg_partner_return_rate_policy'),
  'investor_id,roi_percentage,entitled_rate,rate_basis,rate_decided_at,rate_existing_at_decision');
SELECT pg_temp.ck('cron', (SELECT string_agg(jobname || '@' || schedule, ',' ORDER BY jobname) FROM cron.job),
  'apply-portfolio-rate-changes-705pm@15 16 * * *,partner-rate-drift-check@1-59/10 * * * *');
SELECT pg_temp.ck('assert.off', (SELECT COALESCE(string_agg(check_name, ','), 'all ok') FROM public.assert_partner_return_policy_intact() WHERE NOT ok), 'all ok');
-- switch never on: decider answers legacy with existing=false
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage, duration_months, portfolio_pin)
VALUES (pg_temp.u('0a'), pg_temp.u('0a'), 'XA', 1000000, 'active', 20, 12, '1111'),
       (pg_temp.u('0b'), pg_temp.u('0b'), 'YA', 1000000, 'active', 15, 12, '1111'),
       (pg_temp.u('0c'), pg_temp.u('0c'), 'ZA', 1000000, 'active', 20, 12, '1111'),
       (pg_temp.u('0d'), pg_temp.u('0d'), 'WA', 1000000, 'active', 20, 12, '1111'),
       (pg_temp.u('0e'), pg_temp.u('0e'), 'SA', 1000000, 'active', 20, 12, '1111');
SELECT pg_temp.ck('off.stamp', pg_temp.pf('XA'), '20|typed_switch_off|null');
SELECT pg_temp.ck('off.decider', pg_temp.rf('0a'), '15|switch_off|false');
INSERT INTO public.hr_staff (user_id, active) VALUES (pg_temp.u('0a'), true), (pg_temp.u('0b'), true), (pg_temp.u('0d'), true), (pg_temp.u('0e'), true);

INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, amount) VALUES (pg_temp.u('0f'), 'Pre Cutoff', '+256709999002', 1000000);
-- Switch on (owner session; release_ready as the Phase 7 step would set it).
UPDATE public.partner_return_policy SET release_ready = true, enabled = true;
SELECT pg_temp.ck('on', (SELECT enabled AND cutoff_at IS NOT NULL FROM public.partner_return_policy)::text, 'true');
SELECT pg_temp.ck('on.decider X/Y/Z', pg_temp.rf('0a') || ' ' || pg_temp.rf('0b') || ' ' || pg_temp.rf('0c'),
  '20|employee|true 20|employee|true 20|existing_partner|true');

-- F1: each opens a new portfolio after the cut-off
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
VALUES (pg_temp.u('0a'), pg_temp.u('0a'), 'XB', 1000000, 'active', 12, '1111'),
       (pg_temp.u('0b'), pg_temp.u('0b'), 'YB', 1000000, 'active', 12, '1111'),
       (pg_temp.u('0c'), pg_temp.u('0c'), 'ZB', 1000000, 'active', 12, '1111');
BEGIN;
SELECT set_config('app.partner_rate_context', 'salary_reinvestment', true);
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
VALUES (pg_temp.u('0e'), pg_temp.u('0e'), 'SB', 100000, 'active', 12, '1111');
COMMIT;
SELECT pg_temp.ck('F1.stamps XB/YB/ZB/SB', pg_temp.pf('XB') || ' ' || pg_temp.pf('YB') || ' ' || pg_temp.pf('ZB') || ' ' || pg_temp.pf('SB'),
  '20|employee|true 20|employee|true 20|existing_partner|true 20|salary_reinvestment|true');
-- W (control): redeems the pre-cut-off portfolio first, then opens one as staff: not existing any more
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE portfolio_code = 'WA';
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
VALUES (pg_temp.u('0d'), pg_temp.u('0d'), 'WB', 1000000, 'active', 12, '1111');
SELECT pg_temp.ck('F1.control WB', pg_temp.pf('WB'), '20|employee|false');
-- pre-cut-off portfolios redeemed; X, Y, W, S leave HR
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE portfolio_code IN ('XA', 'YA', 'ZA', 'SA');
UPDATE public.hr_staff SET active = false;
SELECT pg_temp.ck('F1.after X/Y/Z/W/S', pg_temp.rf('0a') || ' ' || pg_temp.rf('0b') || ' ' || pg_temp.rf('0c') || ' ' || pg_temp.rf('0d') || ' ' || pg_temp.rf('0e'),
  '20|existing_partner|true 15|existing_partner|true 20|existing_partner|true 10|new|false 20|existing_partner|true');
-- a direct write to the stamp is ignored (gate keeps OLD)
UPDATE public.investor_portfolios SET rate_existing_at_decision = true WHERE portfolio_code = 'WB';
SELECT pg_temp.ck('F1.stamp immutable', pg_temp.pf('WB'), '20|employee|false');
-- carve-out child of XB keeps X existing after XB is redeemed (chain carries the flag)
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin, locked_from_portfolio_id)
SELECT pg_temp.u('0a'), pg_temp.u('0a'), 'XC', 100000, 'locked', 12, '1111', id FROM public.investor_portfolios WHERE portfolio_code = 'XB';
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE portfolio_code = 'XB';
SELECT pg_temp.ck('F1.carried XC', pg_temp.pf('XC') || ' / ' || pg_temp.rf('0a'), '20|carried|null / 20|existing_partner|true');

-- F4: invite opened while on (no investor), switch off, claimed by an existing 20 partner -> legacy, not 10
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin, invite_id)
VALUES (NULL, pg_temp.u('0f'), 'INV1', 1000000, 'pending_activation', 12, '1111', gen_random_uuid()),
       (NULL, pg_temp.u('0f'), 'INV2', 1000000, 'pending_activation', 12, '1111', gen_random_uuid()),
       (NULL, pg_temp.u('0f'), 'INV3', 1000000, 'pending_activation', 12, '1111', gen_random_uuid());
SELECT pg_temp.ck('F4.open', pg_temp.pf('INV1'), '10|new_no_investor|null');
UPDATE public.investor_portfolios SET investor_id = pg_temp.u('0c') WHERE portfolio_code = 'INV3';
SELECT pg_temp.ck('F4.claim on (existing 20)', pg_temp.pf('INV3'), '20|existing_partner|true');
UPDATE public.partner_return_policy SET enabled = false;
UPDATE public.investor_portfolios SET investor_id = pg_temp.u('0c') WHERE portfolio_code = 'INV1';
UPDATE public.investor_portfolios SET investor_id = pg_temp.u('11') WHERE portfolio_code = 'INV2';
-- G2 (Phase 6 last round): a claim while off after the cut-off stamps the existing flag (true for the existing 20
-- partner, false for the new person), so an off-period portfolio keeps an existing partner existing.
SELECT pg_temp.ck('F4.claim off (existing 20 / new)', pg_temp.pf('INV1') || ' ' || pg_temp.pf('INV2'), '15|switch_off|true 15|switch_off|false');
UPDATE public.partner_return_policy SET enabled = true;
SELECT pg_temp.ck('F4.on again', pg_temp.pf('INV1') || ' / ' || pg_temp.rf('0c'), '15|switch_off|true / 20|existing_partner|true');

-- conformance: empty; then a forged claimed invite left at new_no_investor and a missing stamp are reported
SELECT pg_temp.ck('conformance.empty', (SELECT COALESCE(string_agg(issue, ','), 'empty') FROM public.partner_rate_conformance(NULL)), 'empty');
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage, duration_months, portfolio_pin,
                                        entitled_rate, rate_basis, rate_decided_at, rate_existing_at_decision)
VALUES (pg_temp.u('0c'), pg_temp.u('0f'), 'FORGE1', 1, 'active', 10, 12, '1111', 10, 'new_no_investor', clock_timestamp(), NULL),
       (pg_temp.u('0c'), pg_temp.u('0f'), 'FORGE2', 1, 'active', 20, 12, '1111', 20, 'employee', clock_timestamp(), NULL),
       (pg_temp.u('0c'), pg_temp.u('0f'), 'FORGE3', 1, 'active', 20, 12, '1111', 20, 'existing_partner', clock_timestamp(), false);
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT pg_temp.ck('conformance.forged', (SELECT string_agg(p.portfolio_code || ':' || c.issue, ',' ORDER BY p.portfolio_code)
   FROM public.partner_rate_conformance(NULL) c JOIN public.investor_portfolios p ON p.id = c.portfolio_id),
  'FORGE1:claimed_invite_not_decided,FORGE2:existing_stamp_missing,FORGE3:existing_stamp_missing');
DELETE FROM public.investor_portfolios WHERE portfolio_code LIKE 'FORGE%';
SELECT pg_temp.ck('assert.on', (SELECT COALESCE(string_agg(check_name, ','), 'all ok') FROM public.assert_partner_return_policy_intact() WHERE NOT ok), 'all ok');

-- F2: a note written after the cut-off (no window) linked late takes no rate lock; a pre-cut-off note
-- with an open window does. Each in its own subtransaction-free block, counted inside the transaction.
INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, amount) VALUES (pg_temp.u('0f'), 'Post Cutoff', '+256709999001', 1000000);
BEGIN;
SELECT pg_temp.ck('F2.before', pg_temp.advisory()::text, '0');
UPDATE public.promissory_notes SET partner_user_id = pg_temp.u('21') WHERE partner_name = 'Post Cutoff';
SELECT pg_temp.ck('F2.post-cutoff note linked: rate locks held', pg_temp.advisory()::text, '0');
COMMIT;
INSERT INTO public.otp_login_audit (resolved_user_id, outcome, phone) VALUES (pg_temp.u('22'), 'success', '+256709999002');
BEGIN;
UPDATE public.promissory_notes SET partner_user_id = pg_temp.u('22') WHERE partner_name = 'Pre Cutoff';
SELECT pg_temp.ck('F2.pre-cutoff note (open window) linked: owner/lock', COALESCE((SELECT partner_user_id::text FROM public.promissory_notes WHERE partner_name = 'Pre Cutoff'), 'held') || '/' || pg_temp.advisory(), pg_temp.u('22')::text || '/1');
COMMIT;

-- G1: the gate's bounded rate-lock wait is a BEGIN ... EXCEPTION block (a sub-transaction). It writes nothing, so a bulk
-- creation in one transaction assigns no sub-transaction ids and never overflows the 64-entry cache (switch on).
BEGIN;
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
SELECT gen_random_uuid(), pg_temp.u('0f'), 'G1SX-' || i, 100000, 'active', 12, '1111' FROM generate_series(1, 100) i;
SELECT pg_stat_clear_snapshot() IS NULL AS x \gset
SELECT (SELECT s.subxact_count || '/' || s.subxact_overflowed FROM pg_stat_get_backend_idset() b, LATERAL pg_stat_get_backend_subxact(b) s
         WHERE pg_stat_get_backend_pid(b) = pg_backend_pid())
       || ' ' || (SELECT count(*) FROM public.investor_portfolios WHERE portfolio_code LIKE 'G1SX-%' AND rate_basis = 'new') AS g1sx \gset
ROLLBACK;
SELECT pg_temp.ck('G1 bulk insert of 100 portfolios (switch on): sub-transaction ids / overflowed, portfolios decided new', :'g1sx', '0/false 100');

SELECT CASE WHEN got IS NOT DISTINCT FROM want THEN 'PASS' ELSE 'FAIL' END || '  P6fix ' || k || CASE WHEN got IS DISTINCT FROM want THEN ' got [' || COALESCE(got, 'NULL') || '] want [' || want || ']' ELSE '' END FROM r;
SELECT 'SUMMARY phase6_fix ' || count(*) FILTER (WHERE got IS NOT DISTINCT FROM want) || ' passed, ' || count(*) FILTER (WHERE got IS DISTINCT FROM want) || ' failed' FROM r;
