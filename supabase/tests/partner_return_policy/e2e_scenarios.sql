-- Partner Returns 10% -- Phase 6 end-to-end persona scenarios. LOCAL THROWAWAY CLUSTER ONLY (port 55432).
--
-- Drives the SQL paths the edge functions and screens call, as the role and JWT each one uses:
--   Partner Ops invite        create_pending_portfolio (caller JWT) + approve_pending_portfolio      [create-portfolio-invite]
--   partner self-serve        funder_create_pending_portfolio (partner JWT)                           [FunderNew screens]
--   back-office invite        service-role INSERT with investor_id NULL, invite_id set               [create-investor-portfolio]
--   invite claim              service-role UPDATE investor_id WHERE invite_id AND investor_id IS NULL [activate-supporter]
--   renewal                   apply_portfolio_renewal (service role) ; set_portfolio_renewal_rate (COO JWT)
--   top-up                    service-role UPDATE investment_amount                                   [merge-pending-topups / approve-portfolio-topup]
--   split / lock              split_portfolio_principal / lock_portfolio_principal (Partner Ops JWT; production text)
--   payroll reinvestment      hr_pay_post_staff_reinvestment (service role)
--   promissory notes          agent_create_promissory_note (agent JWT); activate_promissory_note (partner JWT);
--                             profile-driven linking (production link triggers)
--   Returns payout cycle      amount = round(investment_amount * roi_percentage / 100) from the STORED rate, written as an
--                             approved roi_payout operation (COOPartnersPage computes it this way, approve-wallet-operation approves)
--   rent-facilitation reward  post_rent_facilitation_reward (service role) [process-supporter-roi]
--   CFO                       list_portfolio_rate_requests / cfo_decide_portfolio_rate_requests (CFO JWT) ;
--                             apply_due_portfolio_rate_changes (service role; the 16:05 job)
--   quotes                    partner_quote_rate('public' | 'me' | 'partner')
-- Modes (psql -v mode=...):
--   on     Phase 1/2/4/4b + security migration; release_ready set as the Phase 7 release would; the CEO switches on;
--          later off again, and on again.
--   never  the same database build, switch never turned on: production-identical results expected.
--   base   production's own function texts, no Phase 1/2/4 at all (the baseline the 'never' observations are diffed against).
-- Output: one PASS/FAIL line per check, a SUMMARY line, and table _e_obs (key -> value) for the never/base diff.
-- Run: bash run_phase4_tests.sh e2e (three throwaway databases, then the never-vs-base parity diff). Phase 6 fix round:
-- F1 (S0 ex20hr + S16: existing partners who are staff keep their own rate after leaving HR), F3 (S0 agent RPC answer
-- shape = production), F4 (S15: invites opened while on and claimed while off are decided as production does).
-- Phase 6 last round (S17, mode on): G2 (an existing partner who opens portfolios while the switch is off after the
-- cut-off stays existing; a new person who opens one then is new), G3 (an invite opened while off after the cut-off and
-- claimed while on is decided for the claimant, a typed rate waits for the CFO; a pre-cut-off invite keeps 15, D14).
-- G1 (bounded rate-lock wait) is a concurrency check: race_run_phase6.sh.
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;

SELECT :'mode' = 'on' AS is_on, :'mode' = 'never' AS is_never, :'mode' = 'base' AS is_base, :'mode' <> 'base' AS has_phase \gset

-- ===========================================================================
-- Harness
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public._e_results (n bigserial PRIMARY KEY, name text, ok boolean, got text, want text);
CREATE TABLE IF NOT EXISTS public._e_obs (k text PRIMARY KEY, v text);
CREATE TABLE IF NOT EXISTS public._e_kv (k text PRIMARY KEY, v text);
TRUNCATE public._e_results, public._e_obs, public._e_kv;
INSERT INTO public._e_kv VALUES ('mode', :'mode');

CREATE OR REPLACE FUNCTION public.e_mode() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT v FROM public._e_kv WHERE k = 'mode' $$;
-- Expected value by mode: on -> p_on, never/base -> p_off.
CREATE OR REPLACE FUNCTION public.e_w(p_on text, p_off text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT CASE WHEN public.e_mode() = 'on' THEN p_on ELSE p_off END $$;
CREATE OR REPLACE FUNCTION public.e_check(p_name text, p_got text, p_want text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ok boolean := p_got IS NOT DISTINCT FROM p_want;
BEGIN
  INSERT INTO public._e_results (name, ok, got, want) VALUES (p_name, v_ok, p_got, p_want);
  RETURN CASE WHEN v_ok THEN 'PASS  ' || p_name
              ELSE 'FAIL  ' || p_name || '  got [' || COALESCE(p_got, '<null>') || '] want [' || COALESCE(p_want, '<null>') || ']' END;
END $$;
-- Check + record the observed value for the never/base diff.
CREATE OR REPLACE FUNCTION public.e_ck(p_key text, p_name text, p_got text, p_want text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public._e_obs VALUES (p_key, p_got) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  RETURN public.e_check(p_key || ' ' || p_name, p_got, p_want);
END $$;
CREATE OR REPLACE FUNCTION public.e_set(p_k text, p_v text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ INSERT INTO public._e_kv VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v RETURNING v $$;
CREATE OR REPLACE FUNCTION public.e_get(p_k text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT v FROM public._e_kv WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION public.e_id(p_k text) RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT public.e_get(p_k)::uuid $$;

-- Run p_sql (one value) as a database role with a JWT for p_user (NULL user = no sub). Errors come back as
-- 'ERR:<sqlstate>:<message up to the first colon>'. The role and claims are always reset.
CREATE OR REPLACE FUNCTION public.e_run(p_role text, p_user text, p_sql text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', false);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(public.pid(p_user)::text, ''), false);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN p_role = 'postgres' THEN '' ELSE p_role END, false);
  BEGIN
    IF p_role <> 'postgres' THEN EXECUTE format('SET ROLE %I', p_role); END IF;
    EXECUTE p_sql INTO v;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    v := 'ERR:' || SQLSTATE || ':' || split_part(SQLERRM, ':', 1);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM set_config('request.jwt.claim.role', '', false);
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.e_person(p_name text, p_phone text, p_email text DEFAULT NULL) RETURNS uuid
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (public.pid(p_name), COALESCE(p_email, p_name || '@e2e.test')) ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, full_name, phone, email)
  VALUES (public.pid(p_name), initcap(replace(p_name, '_', ' ')), p_phone, COALESCE(p_email, p_name || '@e2e.test'))
  ON CONFLICT (id) DO NOTHING;
  RETURN public.pid(p_name);
END $$;

CREATE OR REPLACE FUNCTION public.e_roi(p_id uuid) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT trim_scale(roi_percentage)::text FROM public.investor_portfolios WHERE id = p_id $$;
-- basis|pending CFO request rates (Phase builds only)
CREATE OR REPLACE FUNCTION public.e_meta(p_id uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v text;
BEGIN
  IF to_regclass('public.portfolio_rate_approvals') IS NULL THEN RETURN 'n/a'; END IF;
  EXECUTE $q$SELECT COALESCE(ip.rate_basis, '-') || '|' || COALESCE((SELECT string_agg(trim_scale(a.requested_rate)::text, ',' ORDER BY a.requested_at)
            FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id AND a.status = 'pending'), '-')
            FROM public.investor_portfolios ip WHERE ip.id = $1$q$ INTO v USING p_id;
  RETURN v;
END $$;
-- One Returns payout cycle on a portfolio: the amount from the STORED rate (as COOPartnersPage), recorded approved.
CREATE OR REPLACE FUNCTION public.e_pay(p_id uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_amt numeric; v_inv uuid;
BEGIN
  SELECT round(ip.investment_amount * ip.roi_percentage / 100), ip.investor_id INTO v_amt, v_inv
    FROM public.investor_portfolios ip WHERE ip.id = p_id;
  INSERT INTO public.pending_wallet_operations (source_id, source_table, category, status, reviewed_at, user_id, amount, direction,
                                                description, operation_type, metadata)
  VALUES (p_id, 'investor_portfolios', 'roi_payout', 'approved', now(), v_inv, v_amt, 'cash_in',
          'e2e Returns payout', 'roi_wallet_credit', '{}'::jsonb);
  RETURN v_amt::text;
END $$;
CREATE OR REPLACE FUNCTION public.e_set_status(p_id uuid, p_status text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ UPDATE public.investor_portfolios SET status = p_status WHERE id = p_id RETURNING status $$;
-- Partner Ops opens a portfolio for a person with an optional typed rate, then approves it (create-portfolio-invite).
CREATE OR REPLACE FUNCTION public.e_invite(p_key text, p_person text, p_rate numeric, p_amount numeric DEFAULT 1000000) RETURNS text
 LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text; a text;
BEGIN
  v := public.e_run('authenticated', 'e_pops', format(
         $f$SELECT portfolio_id::text FROM public.create_pending_portfolio(public.pid(%L), %s, 12, %s, 'monthly_payout', 'e2e', repeat('k', 40))$f$,
         p_person, p_amount, COALESCE(p_rate::text, 'NULL')));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  PERFORM public.e_set(p_key, v);
  a := public.e_run('authenticated', 'e_pops', format('SELECT public.approve_pending_portfolio(%L::uuid)::text', v));
  IF a LIKE 'ERR:%' THEN RETURN a; END IF;
  RETURN public.e_roi(v::uuid);
END $$;
CREATE OR REPLACE FUNCTION public.e_quote(p_user text, p_for text, p_partner text DEFAULT NULL) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT public.e_run(CASE WHEN p_user IS NULL THEN 'anon' ELSE 'authenticated' END, p_user,
           format('SELECT trim_scale(public.partner_quote_rate(%L, %s))::text', p_for,
                  CASE WHEN p_partner IS NULL THEN 'NULL' ELSE format('public.pid(%L)', p_partner) END)) $$;
CREATE OR REPLACE FUNCTION public.e_note(p_key text, p_phone text, p_due_days integer DEFAULT 10, p_agent text DEFAULT 'e_agent',
                                        p_amount numeric DEFAULT 1000000) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text;
BEGIN
  v := public.e_run('authenticated', p_agent, format(
         $f$SELECT public.agent_create_promissory_note(jsonb_build_object('amount', %s, 'partner_name', %L, 'whatsapp_number', %L,
              'fulfilment_due_on', (current_date + %s)::text))::text$f$, p_amount, 'Partner ' || p_key, p_phone, p_due_days));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  PERFORM public.e_set(p_key || '_resp', v);
  PERFORM public.e_set(p_key, (SELECT n.id::text FROM public.promissory_notes n WHERE n.whatsapp_number = p_phone ORDER BY n.created_at DESC LIMIT 1));
  RETURN public.e_get(p_key);
END $$;
CREATE OR REPLACE FUNCTION public.e_note_owner(p_key text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id = n.partner_user_id), CASE WHEN n.partner_user_id IS NULL THEN 'unlinked' ELSE 'other' END)
       FROM public.promissory_notes n WHERE n.id = public.e_id(p_key) $$;
CREATE OR REPLACE FUNCTION public.e_note_rate(p_key text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'promissory_notes' AND column_name = 'return_rate') THEN RETURN 'n/a'; END IF;
  EXECUTE 'SELECT trim_scale(return_rate) || ''/'' || return_rate_basis FROM public.promissory_notes WHERE id = $1' INTO v USING public.e_id(p_key);
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.e_pledge(p_key text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT trim_scale(monthly_return) || '/' || trim_scale(annual_return) || '/' || COALESCE(phone, '-') FROM public.promissory_note_pledge_notices WHERE note_id = public.e_id(p_key) $$;
-- A funded rent request (fund-tenants sets supporter_id); due for its first reward.
CREATE OR REPLACE FUNCTION public.e_rr(p_key text, p_supporter text, p_rent numeric DEFAULT 600000) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH x AS (INSERT INTO public.rent_requests (tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at, approved_at, request_city)
             VALUES (gen_random_uuid(), gen_random_uuid(), p_rent, 'funded', public.pid(p_supporter), now() - interval '31 days',
                     now() - interval '32 days', 'Kampala') RETURNING id)
  SELECT public.e_set(p_key, x.id::text) FROM x $$;
-- The 06:00 job posting reward #1 (process-supporter-roi): amount@rate and the wallet line text.
CREATE OR REPLACE FUNCTION public.e_reward(p_key text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text; d text;
BEGIN
  v := public.e_run('service_role', NULL, format(
         $f$SELECT public.post_rent_facilitation_reward(%L::uuid, 1, NULL,
              CASE WHEN public.e_mode() = 'base'
                   THEN '15%% monthly reward (payment #1) on rent facilitation of UGX ' || to_char((SELECT rent_amount FROM public.rent_requests WHERE id = %L::uuid), 'FM999,999,999,990')
                   ELSE 'Monthly Returns (payment #1) on rent facilitation of UGX ' || to_char((SELECT rent_amount FROM public.rent_requests WHERE id = %L::uuid), 'FM999,999,999,990') END)::text$f$,
         public.e_get(p_key), public.e_get(p_key), public.e_get(p_key)));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  SELECT g.description INTO d FROM public.general_ledger g
   WHERE g.source_id = public.e_id(p_key) AND g.category = 'roi_wallet_credit' ORDER BY g.created_at DESC LIMIT 1;
  PERFORM public.e_set(p_key || '_desc', d);
  RETURN (v::jsonb ->> 'amount') || '@' || COALESCE(v::jsonb ->> 'rate', '-');
END $$;
-- The pending CFO request on a portfolio (read as the owner, then passed to the RPC as a literal).
CREATE OR REPLACE FUNCTION public.e_req(p_key text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v text;
BEGIN
  EXECUTE 'SELECT id::text FROM public.portfolio_rate_approvals WHERE portfolio_id = $1 AND status = ''pending''' INTO v USING public.e_id(p_key);
  RETURN v;
END $$;
-- The newest request on a portfolio: status:applied (fresh read).
CREATE OR REPLACE FUNCTION public.e_last_req(p_key text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v text;
BEGIN
  EXECUTE 'SELECT status || '':'' || (applied_at IS NOT NULL) FROM public.portfolio_rate_approvals WHERE portfolio_id = $1 ORDER BY requested_at DESC LIMIT 1'
    INTO v USING public.e_id(p_key);
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.e_decide(p_user text, p_key text, p_decision text, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT public.e_run('authenticated', p_user, format('SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[%L::uuid], %L, %L)::text',
                                                       public.e_req(p_key), p_decision, p_note)) $$;
-- Payroll fixture: an approved run with one REINVEST line (as phase2_helpers.t2_payslip).
CREATE OR REPLACE FUNCTION public.e_payslip(p_person text, p_amount numeric DEFAULT 200000, p_active boolean DEFAULT true) RETURNS uuid
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_staff uuid; v_period uuid; v_run uuid; v_ps uuid;
BEGIN
  INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid(p_person), p_active)
  ON CONFLICT (user_id) DO UPDATE SET active = EXCLUDED.active RETURNING id INTO v_staff;
  INSERT INTO public.hr_pay_periods (code) VALUES ('2026-11') RETURNING id INTO v_period;
  INSERT INTO public.hr_pay_runs (period_id, status) VALUES (v_period, 'approved') RETURNING id INTO v_run;
  INSERT INTO public.hr_pay_payslips (run_id, staff_id, net, inputs_snapshot)
  VALUES (v_run, v_staff, 0, '{"reinvestment":{"percentage":10,"payout_mode":"monthly_payout"}}') RETURNING id INTO v_ps;
  INSERT INTO public.hr_pay_payslip_lines (payslip_id, component_code, amount) VALUES (v_ps, 'REINVEST', p_amount);
  RETURN v_ps;
END $$;
CREATE OR REPLACE FUNCTION public.e_reinvest(p_key text, p_person text, p_active boolean DEFAULT true) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text; ps uuid := public.e_payslip(p_person, 200000, p_active);
BEGIN
  v := public.e_run('service_role', NULL, format('SELECT public.hr_pay_post_staff_reinvestment(%L::uuid)::text', ps));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  PERFORM public.e_set(p_key, v::jsonb ->> 'portfolio_id');
  RETURN (v::jsonb ->> 'kind') || ':' || COALESCE(public.e_roi((v::jsonb ->> 'portfolio_id')::uuid), '-');
END $$;
-- Back-office invite portfolio with no investor (create-investor-portfolio, admin client), optional typed rate.
CREATE OR REPLACE FUNCTION public.e_open_invite(p_key text, p_rate numeric) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text;
BEGIN
  v := public.e_run('service_role', NULL, format(
    $f$INSERT INTO public.investor_portfolios (investor_id, invite_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin %s)
       VALUES (NULL, %L::uuid, public.pid('e_pops'), %L, 1000000, 'active', 12, '4321' %s) RETURNING id::text$f$,
    CASE WHEN p_rate IS NULL THEN '' ELSE ', roi_percentage' END, gen_random_uuid(), 'INV-' || p_key,
    CASE WHEN p_rate IS NULL THEN '' ELSE ', ' || p_rate END));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  PERFORM public.e_set(p_key, v);
  RETURN public.e_roi(v::uuid);
END $$;
CREATE OR REPLACE FUNCTION public.e_claim(p_key text, p_person text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(NULLIF(public.e_run('service_role', NULL, format(
    $f$WITH u AS (UPDATE public.investor_portfolios SET investor_id = public.pid(%L)
                   WHERE invite_id = (SELECT invite_id FROM public.investor_portfolios WHERE id = %L::uuid) AND investor_id IS NULL RETURNING id)
       SELECT count(*)::text FROM u$f$, p_person, public.e_get(p_key))), '1'), public.e_roi(public.e_id(p_key))) $$;
-- Simulated passage of time for one frozen note window (the window table is append-only; the harness disables its guard
-- for this single UPDATE, as the owner could). Nothing else is changed.
CREATE OR REPLACE FUNCTION public.e_close_window(p_key text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER trg_partner_return_note_windows_guard;
  UPDATE public.partner_return_note_windows SET ends_on = current_date - 1 WHERE note_id = public.e_id(p_key);
  ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER trg_partner_return_note_windows_guard;
  RETURN (SELECT (ends_on < current_date)::text FROM public.partner_return_note_windows WHERE note_id = public.e_id(p_key));
END $$;

-- ===========================================================================
-- S0. People and pre-cut-off history (switch OFF in every mode: today's production)
-- ===========================================================================
INSERT INTO auth.users (id, email) VALUES (public.pid('e_pops'), 'pops@e2e.test'), (public.pid('e_agent'), 'agent@e2e.test'),
  (public.pid('e_coo'), 'coo@e2e.test') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, full_name, email) VALUES (public.pid('e_pops'), 'E Pops', 'pops@e2e.test'),
  (public.pid('e_agent'), 'E Agent', 'agent@e2e.test'), (public.pid('e_coo'), 'E Coo', 'coo@e2e.test') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('e_pops'), 'partner_ops', true),
  (public.pid('e_agent'), 'agent', true), (public.pid('e_coo'), 'coo', true) ON CONFLICT DO NOTHING;
SELECT count(*) FILTER (WHERE x IS NOT NULL) AS people FROM (SELECT public.e_person(n, p) x FROM (VALUES
  ('e_ex20', '+256701000020'), ('e_ex15', '+256701000015'), ('e_redeem', '+256701000030'), ('e_emp', '+256701000040'),
  ('e_emp15', '+256701000041'), ('e_exemp', '+256701000042'), ('e_note_a', '+256701000101'), ('e_note_b', '+256701000102'),
  ('e_note_c', '+256701000103'), ('e_new1', '+256701000201'), ('e_newtyped', '+256701000202'), ('e_newrej', '+256701000203'),
  ('e_invnew', '+256701000204'), ('e_selfnew', '+256701000205'), ('e_tok', '+256701000999'), ('e_off1', '+256701000301'),
  ('e_selfex', '+256701000206'), ('e_ex20hr', '+256701000043'), ('e_g2ex', '+256701000501'), ('e_g2new', '+256701000502'),
  ('e_g3a', '+256701000503'), ('e_g3b', '+256701000504'), ('e_g3c', '+256701000505'), ('e_g3d', '+256701000506')) v(n, p)) s \gset
INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('e_emp'), true), (public.pid('e_emp15'), true), (public.pid('e_ex20hr'), true) ON CONFLICT (user_id) DO NOTHING;

-- Existing partners: Partner Ops opened their portfolios with the rate the old screen sent (typed).
SELECT public.e_ck('S0.ex20', 'pre-cut-off portfolio typed 20 -> stored 20', public.e_invite('ex20_p0', 'e_ex20', 20), '20');
SELECT public.e_ck('S0.ex15', 'pre-cut-off portfolio typed 15 -> stored 15', public.e_invite('ex15_p0', 'e_ex15', 15), '15');
SELECT public.e_ck('S0.redeem', 'pre-cut-off portfolio typed 20 -> stored 20', public.e_invite('redeem_p0', 'e_redeem', 20), '20');
SELECT public.e_ck('S0.emp15', 'employee with a pre-cut-off 15 portfolio', public.e_invite('emp15_p0', 'e_emp15', 15), '15');
SELECT public.e_ck('S0.ex20hr', 'employee with a pre-cut-off 20 portfolio (Phase 6 F1)', public.e_invite('ex20hr_p0', 'e_ex20hr', 20), '20');
SELECT public.e_ck('S0.g2ex', 'pre-cut-off portfolio typed 20 (Phase 6 G2: opens portfolios during an off period later)', public.e_invite('g2ex_p0', 'e_g2ex', 20), '20');
SELECT public.e_ck('S0.g3pre', 'pre-cut-off back-office invite, no rate, left unclaimed (Phase 6 G3, D14)', public.e_open_invite('g3_pre', NULL), '15');
SELECT public.e_ck('S0.pay.ex20', 'Returns cycle on a 20% 1,000,000 portfolio pays 200,000', public.e_pay(public.e_id('ex20_p0')), '200000');
SELECT public.e_ck('S0.pay.ex15', 'Returns cycle on a 15% 1,000,000 portfolio pays 150,000', public.e_pay(public.e_id('ex15_p0')), '150000');
\if :has_phase
SELECT public.e_check('S0 typed rates while off: no CFO request, basis typed_switch_off',
  public.e_meta(public.e_id('ex20_p0')) || ' / ' || (SELECT count(*) FROM public.portfolio_rate_approvals), 'typed_switch_off|- / 0');
\endif

-- Promissory notes written before the cut-off (agent JWT). Linked at insert by phone (production trigger) where the
-- person already has an account; two are left unlinked (token activation; sign-up later).
SELECT public.e_note('note_a', '+256701000101') IS NOT NULL AS x \gset
SELECT public.e_note('note_b', '+256701000102') IS NOT NULL AS x \gset
SELECT public.e_note('note_c', '+256701000103') IS NOT NULL AS x \gset
SELECT public.e_note('note_tok', '+256701000777') IS NOT NULL AS x \gset
SELECT public.e_note('note_signup', '+256701000555') IS NOT NULL AS x \gset
SELECT public.e_ck('S0.note.link', 'pre-cut-off notes linked by phone at insert / unlinked',
  public.e_note_owner('note_a') || ',' || public.e_note_owner('note_tok') || ',' || public.e_note_owner('note_signup'), 'E Note A,unlinked,unlinked');
SELECT public.e_ck('S0.note.pledge', 'pledge notice for a 1,000,000 note: 150,000 a month / 1,800,000 a year, to the WhatsApp number',
  public.e_pledge('note_a'), '150000/1800000/+256701000101');
SELECT public.e_ck('S0.note.resp', 'agent_create_promissory_note answer for a note linked at insert to another person: monthly_return / annual_return / note.partner_user_id',
  COALESCE(public.e_get('note_a_resp')::jsonb ->> 'monthly_return', 'null') || '/' || COALESCE(public.e_get('note_a_resp')::jsonb ->> 'annual_return', 'null')
  || '/' || ((public.e_get('note_a_resp')::jsonb -> 'note') ? 'partner_user_id')::text,
  '150000/1800000/true');   -- Phase 6 F3: a legacy note's rate is public (production parity in every mode)
-- Phase 6 F3: the whole answer of the agent RPC with the switch never on is production's: same top-level keys, same keys
-- in 'note' (the columns Phase 1/2 add to promissory_notes aside), same figures, for a linked and an unlinked note.
-- One known, additive difference is kept out of the parity observation and pinned on its own below: the Phase 2 answer
-- carries a top-level return_rate (15 while off) that production's answer does not have (tester finding, Phase 6).
CREATE OR REPLACE FUNCTION public.e_resp_shape(p_key text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r) k WHERE k <> 'return_rate') || ' | note: '
      || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r -> 'note') k WHERE k NOT IN ('return_rate', 'return_rate_basis'))
      || ' | ' || COALESCE(r ->> 'monthly_return', 'null') || '/' || COALESCE(r ->> 'annual_return', 'null')
      || '/' || COALESCE(r -> 'note' ->> 'amount', 'null') || '/' || (r -> 'note' ->> 'partner_user_id' IS NOT NULL)::text
    FROM (SELECT public.e_get(p_key || '_resp')::jsonb r) s $$;
\if :is_on
\else
SELECT public.e_check('S0.note.extra_key top-level keys of the agent RPC answer beyond production''s (never: return_rate, the known additive key; base: none)',
  COALESCE((SELECT string_agg(k || '=' || (r ->> k), ',' ORDER BY k) FROM jsonb_object_keys(r) k
             WHERE k NOT IN ('annual_return', 'attached_amount', 'attached_count', 'monthly_return', 'note', 'support_mode')), 'none'),
  CASE WHEN :'mode' = 'base' THEN 'none' ELSE 'return_rate=15' END)
  FROM (SELECT public.e_get('note_a_resp')::jsonb r) s;
\endif
SELECT public.e_ck('S0.note.shape_linked', 'agent RPC answer shape, note linked at insert (observation: never must equal base)', public.e_resp_shape('note_a'), public.e_resp_shape('note_a'));
SELECT public.e_ck('S0.note.shape_unlinked', 'agent RPC answer shape, unlinked note (observation: never must equal base)', public.e_resp_shape('note_tok'), public.e_resp_shape('note_tok'));
\if :has_phase
SELECT public.e_check('S0.note.rate pre-cut-off notes stamped 15 / legacy', public.e_note_rate('note_a') || ',' || public.e_note_rate('note_tok'), '15/legacy,15/legacy');
\endif
-- A rent request funded before the cut-off by the 20% partner (fund-tenants sets supporter_id).
SELECT public.e_rr('rr_pre', 'e_ex20') IS NOT NULL AS x \gset

-- ===========================================================================
-- S1. Release and switch-on (mode on only)
-- ===========================================================================
\if :is_on
-- Phase 7 release migration: refuses unless the assert (except history/readiness) and the Phase 4 release checks pass.
DO $rel$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(check_name, ',') INTO v_bad FROM public.assert_partner_return_policy_intact()
   WHERE NOT ok AND check_name NOT IN ('rates_conform', 'release_ready');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'release refused: assert %', v_bad; END IF;
  SELECT string_agg(check_name, ',') INTO v_bad FROM public._partner_return_phase4_checks(true) WHERE NOT ok;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'release refused: phase4 %', v_bad; END IF;
  UPDATE public.partner_return_policy SET release_ready = true, note = 'Phase 7 release (e2e)' WHERE id;
END $rel$;
SELECT public.e_check('S1 release_ready set by the release step; switch still off',
  (SELECT release_ready || '/' || enabled FROM public.partner_return_policy), 'true/false');
SELECT public.e_check('S1 the CFO cannot switch on', public.e_run('authenticated', 'cfo', 'SELECT public.set_partner_return_policy(true)::text'), 'ERR:42501:Only the CEO can turn Partner Returns on or off');
SELECT public.e_check('S1 the service role cannot switch on', left(public.e_run('service_role', NULL, 'SELECT public.set_partner_return_policy(true)::text'), 10), 'ERR:42501:');
SELECT public.e_check('S1 the CEO switches on',
  (public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(true, NULL, 'e2e switch-on')::text$$))::jsonb ->> 'enabled', 'true');
SELECT public.e_set('cutoff', (SELECT cutoff_at::text FROM public.partner_return_policy)) IS NOT NULL AS x \gset
SELECT public.e_check('S1 cut-off set; cohort = the live holders (ex20 max 20, ex15 15, ex20hr 20, g2ex 20, redeem 20, emp15 15); note people and the unclaimed invite not in it',
  (SELECT string_agg(p.full_name || '=' || trim_scale(c.max_rate), ',' ORDER BY p.full_name) FROM public.partner_return_cohort c
     JOIN public.profiles p ON p.id = c.partner_id WHERE p.full_name LIKE 'E %'), 'E Emp15=15,E Ex15=15,E Ex20=20,E Ex20hr=20,E G2ex=20,E Redeem=20');
SELECT public.e_check('S1 frozen windows for the five pre-cut-off notes at 15',
  (SELECT count(*) || '@' || string_agg(DISTINCT trim_scale(w.return_rate)::text, ',') FROM public.partner_return_note_windows w
    WHERE w.note_id IN (public.e_id('note_a'), public.e_id('note_b'), public.e_id('note_c'), public.e_id('note_tok'), public.e_id('note_signup'))), '5@15');
SELECT public.e_check('S1 public policy reads on / 10', (SELECT (j ->> 'enabled') || '/' || (j ->> 'new_contract_rate') FROM public.get_partner_return_policy() j), 'true/10');
\endif

-- ===========================================================================
-- S2. New portfolio with no typed rate (new screens / edge send none; the old screens and production send 15)
-- ===========================================================================
\if :is_base
SELECT public.e_check('S2 base: production refuses a blank rate (INVALID_ROI); old screens always send one',
  public.e_invite('x_null', 'e_new1', NULL), 'ERR:P0001:INVALID_ROI');
\endif
CREATE OR REPLACE FUNCTION public.e_s2(p_person text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT public.e_invite('s2_' || p_person, p_person, CASE WHEN public.e_mode() = 'base' THEN 15 END) $$;
SELECT public.e_ck('S2.new1', 'NEW partner, no rate -> stored', public.e_s2('e_new1'), public.e_w('10', '15'));
SELECT public.e_ck('S2.ex20', 'EXISTING 20 partner, new portfolio -> stored', public.e_s2('e_ex20'), public.e_w('20', '15'));
SELECT public.e_ck('S2.ex15', 'EXISTING 15 partner, new portfolio -> stored', public.e_s2('e_ex15'), '15');
SELECT public.e_ck('S2.emp', 'EMPLOYEE (no portfolio), new portfolio -> stored', public.e_s2('e_emp'), public.e_w('20', '15'));
SELECT public.e_ck('S2.emp15', 'EMPLOYEE who is also an existing 15 partner -> stored', public.e_s2('e_emp15'), public.e_w('20', '15'));
SELECT public.e_ck('S2.note_a', 'PRE-CUT-OFF NOTE partner inside the window -> stored', public.e_s2('e_note_a'), '15');
SELECT public.e_ck('S2.note_c', 'PRE-CUT-OFF NOTE partner (c) inside the window -> stored', public.e_s2('e_note_c'), '15');
\if :is_on
SELECT public.e_check('S2 bases: new / existing_partner x2 / employee x2 / promissory_note x2, no CFO request',
  public.e_meta(public.e_id('s2_e_new1')) || ',' || public.e_meta(public.e_id('s2_e_ex20')) || ',' || public.e_meta(public.e_id('s2_e_ex15')) || ','
  || public.e_meta(public.e_id('s2_e_emp')) || ',' || public.e_meta(public.e_id('s2_e_emp15')) || ',' || public.e_meta(public.e_id('s2_e_note_a')) || ','
  || public.e_meta(public.e_id('s2_e_note_c')),
  'new|-,existing_partner|-,existing_partner|-,employee|-,employee|-,promissory_note|-,promissory_note|-');
\endif
\if :is_never
SELECT public.e_check('S2 never: the gate fills 15 (switch_off) and queues nothing',
  public.e_meta(public.e_id('s2_e_new1')) || ' / ' || (SELECT count(*) FROM public.portfolio_rate_approvals), 'switch_off|- / 0');
SELECT public.e_check('S2 never: an old screen typing 15 is still accepted as 15 (typed_switch_off)',
  public.e_invite('s2_old15', 'e_new1', 15) || '|' || public.e_meta(public.e_id('s2_old15')), '15|typed_switch_off|-');
\endif
-- Returns payout cycle on each (1,000,000): the paid amount follows the stored rate.
SELECT public.e_ck('S2.pay.new1', 'Returns cycle pays', public.e_pay(public.e_id('s2_e_new1')), public.e_w('100000', '150000'));
SELECT public.e_ck('S2.pay.ex20', 'Returns cycle pays', public.e_pay(public.e_id('s2_e_ex20')), public.e_w('200000', '150000'));
SELECT public.e_ck('S2.pay.ex15', 'Returns cycle pays', public.e_pay(public.e_id('s2_e_ex15')), '150000');
SELECT public.e_ck('S2.pay.emp', 'Returns cycle pays', public.e_pay(public.e_id('s2_e_emp')), public.e_w('200000', '150000'));
SELECT public.e_ck('S2.pay.note_a', 'Returns cycle pays', public.e_pay(public.e_id('s2_e_note_a')), '150000');

-- ===========================================================================
-- S3. Typed rates and the CFO
-- ===========================================================================
SELECT public.e_ck('S3.ex20.typed20', 'EXISTING 20, staff type 20 -> stored', public.e_invite('s3_ex20_t20', 'e_ex20', 20), '20');
SELECT public.e_ck('S3.ex20.typed15', 'EXISTING 20, staff type 15 -> stored (on: own 20 kept, lowering waits for the CFO)',
  public.e_invite('s3_ex20_t15', 'e_ex20', 15), public.e_w('20', '15'));
SELECT public.e_ck('S3.emp.typed15', 'EMPLOYEE, staff type 15 -> stored', public.e_invite('s3_emp_t15', 'e_emp', 15), public.e_w('20', '15'));
SELECT public.e_ck('S3.newtyped', 'NEW partner, staff type 15 -> stored', public.e_invite('s3_newtyped', 'e_newtyped', 15), public.e_w('10', '15'));
SELECT public.e_ck('S3.newrej', 'NEW partner, staff type 20 -> stored', public.e_invite('s3_newrej', 'e_newrej', 20), public.e_w('10', '20'));
\if :is_on
SELECT public.e_check('S3 CFO requests: ex20 t20 none; ex20 t15, emp t15, new t15, new t20 pending at the typed rate',
  public.e_meta(public.e_id('s3_ex20_t20')) || ',' || public.e_meta(public.e_id('s3_ex20_t15')) || ',' || public.e_meta(public.e_id('s3_emp_t15')) || ','
  || public.e_meta(public.e_id('s3_newtyped')) || ',' || public.e_meta(public.e_id('s3_newrej')),
  'existing_partner|-,existing_partner|15,employee|15,new|15,new|20');
SELECT public.e_check('S3 the request records the Partner Ops typist (caller JWT), and the CFO queue lists it',
  (SELECT a.requested_by = public.pid('e_pops') FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = public.e_id('s3_newtyped') AND a.status = 'pending')::text
  || '/' || public.e_run('authenticated', 'cfo', $$SELECT count(*)::text FROM public.list_portfolio_rate_requests('pending') WHERE requested_by_name = 'E Pops'$$),
  'true/4');
SELECT public.e_check('S3 Partner Ops cannot decide a rate request', public.e_decide('e_pops', 's3_newtyped', 'approve'),
  'ERR:42501:Only the CFO can decide partner Returns rates');
SELECT public.e_check('S3 CFO approves new t15; a rejection needs a reason; CFO rejects new t20',
  (public.e_decide('cfo', 's3_newtyped', 'approve')::jsonb ->> 'decided') || '/' || public.e_decide('cfo', 's3_newrej', 'reject')
  || '/' || (public.e_decide('cfo', 's3_newrej', 'reject', 'Standard rate applies')::jsonb ->> 'decided'),
  '1/ERR:P0001:A reason is required to reject/1');
SELECT public.e_check('S3 approval alone does not move the rate (still 10)', public.e_roi(public.e_id('s3_newtyped')), '10');
SELECT public.e_check('S3 D10: the next-cycle job applies the approved 15 BEFORE the first payout',
  ((public.e_run('service_role', NULL, 'SELECT public.apply_due_portfolio_rate_changes()::text'))::jsonb ->> 'applied') || '/' || public.e_roi(public.e_id('s3_newtyped')), '1/15');
\endif
SELECT public.e_ck('S3.pay.newtyped', 'first Returns cycle of the typed-15 new partner pays', public.e_pay(public.e_id('s3_newtyped')), '150000');
SELECT public.e_ck('S3.pay.newrej', 'first Returns cycle of the typed-20 new partner pays (on: rejected -> 10)', public.e_pay(public.e_id('s3_newrej')), public.e_w('100000', '200000'));
SELECT public.e_ck('S3.pay.ex20t15', 'existing 20 typed 15 pays', public.e_pay(public.e_id('s3_ex20_t15')), public.e_w('200000', '150000'));
\if :is_on
SELECT public.e_check('S3 after the job: newtyped 15 (request applied), newrej 10, ex20 lowering still pending',
  public.e_roi(public.e_id('s3_newtyped')) || ',' || public.e_roi(public.e_id('s3_newrej')) || ',' || public.e_meta(public.e_id('s3_ex20_t15')),
  '15,10,existing_partner|15');
\endif

-- ===========================================================================
-- S4. Partner self-serve (funder_create_pending_portfolio, partner JWT; production hard-codes 15)
-- ===========================================================================
INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url, countersigned_at, status)
VALUES (public.pid('e_selfnew'), 'data:image/png;base64,AAAA', now(), 'countersigned'),
       (public.pid('e_ex20'), 'data:image/png;base64,AAAA', now(), 'countersigned'),
       (public.pid('e_ex15'), 'data:image/png;base64,AAAA', now(), 'countersigned');
CREATE OR REPLACE FUNCTION public.e_self(p_key text, p_person text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text;
BEGIN
  v := public.e_run('authenticated', p_person, 'SELECT public.funder_create_pending_portfolio(500000)::text');
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  PERFORM public.e_set(p_key, v::jsonb ->> 'portfolio_id');
  RETURN public.e_roi((v::jsonb ->> 'portfolio_id')::uuid) || '|' || COALESCE(v::jsonb ->> 'roi_percentage', 'no rate in answer');
END $$;
SELECT public.e_ck('S4.selfnew', 'NEW partner self-serve -> stored|answer', split_part(public.e_self('s4_selfnew', 'e_selfnew'), '|', 1), public.e_w('10', '15'));
SELECT public.e_ck('S4.selfex20', 'EXISTING 20 self-serve -> stored', split_part(public.e_self('s4_ex20', 'e_ex20'), '|', 1), public.e_w('20', '15'));
SELECT public.e_ck('S4.selfex15', 'EXISTING 15 self-serve -> stored', split_part(public.e_self('s4_ex15', 'e_ex15'), '|', 1), '15');

-- ===========================================================================
-- S5. Back-office invite and its claim (activate-supporter)
-- ===========================================================================
SELECT public.e_ck('S5.inv1.open', 'invite with no investor, no rate -> stored', public.e_open_invite('inv1', NULL), public.e_w('10', '15'));
SELECT public.e_ck('S5.inv1.claim', 'claimed by the EXISTING 20 partner -> stored', public.e_claim('inv1', 'e_ex20'), public.e_w('20', '15'));
SELECT public.e_ck('S5.inv2.open', 'second invite, no rate', public.e_open_invite('inv2', NULL), public.e_w('10', '15'));
SELECT public.e_ck('S5.inv2.claim', 'claimed by a NEW person -> stored', public.e_claim('inv2', 'e_invnew'), public.e_w('10', '15'));
SELECT public.e_ck('S5.inv3.open', 'third invite, staff typed 15', public.e_open_invite('inv3', 15), public.e_w('10', '15'));
SELECT public.e_ck('S5.inv3.claim', 'claimed by the EXISTING 20 partner -> stored', public.e_claim('inv3', 'e_ex20'), public.e_w('20', '15'));
\if :is_on
SELECT public.e_check('S5 bases after claim; the typed 15 is re-measured against the claimant (lowering 20 -> 15 for the CFO)',
  public.e_meta(public.e_id('inv1')) || ',' || public.e_meta(public.e_id('inv2')) || ',' || public.e_meta(public.e_id('inv3')) || ','
  || (SELECT trim_scale(standard_rate) || '>' || trim_scale(requested_rate) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.e_id('inv3') AND status = 'pending'),
  'existing_partner|-,new|-,existing_partner|15,20>15');
\endif
SELECT public.e_ck('S5.inv4.open', 'fourth invite, no rate', public.e_open_invite('inv4', NULL), public.e_w('10', '15'));
SELECT public.e_ck('S5.inv4.claim', 'claimed by the EXISTING 15 partner -> stored', public.e_claim('inv4', 'e_ex15'), '15');
SELECT public.e_ck('S5.pay.inv1', 'Returns cycle on the claimed invite', public.e_pay(public.e_id('inv1')), public.e_w('200000', '150000'));

-- ===========================================================================
-- S6. Renewal
-- ===========================================================================
UPDATE public.investor_portfolios SET maturity_date = current_date - 5, next_roi_date = current_date + 40 WHERE id = public.e_id('ex20_p0');
SELECT public.e_ck('S6.ex20.renew', 'auto-renewal (apply_portfolio_renewal) of the 20% pre-cut-off portfolio -> rate kept',
  (public.e_run('service_role', NULL, format($$SELECT public.apply_portfolio_renewal(%L::uuid, NULL, 'e2e renewal', 'auto', true)::text$$, public.e_get('ex20_p0'))))::jsonb ->> 'roi_percentage'
  || '/' || public.e_roi(public.e_id('ex20_p0')), '20/20');
SELECT public.e_ck('S6.ex20.renewrow', 'renewal row old -> new rate', (SELECT trim_scale(old_roi_percentage) || '>' || trim_scale(new_roi_percentage) FROM public.portfolio_renewals
  WHERE portfolio_id = public.e_id('ex20_p0') ORDER BY created_at DESC LIMIT 1), '20>20');
\if :has_phase
SELECT public.e_ck('S6.ex15.renewrate', 'COO asks for 18 on renewal of the 15 portfolio (set_portfolio_renewal_rate) -> rate in force',
  (public.e_run('authenticated', 'e_coo', format('SELECT public.set_portfolio_renewal_rate(%L::uuid, 18)::text', public.e_get('ex15_p0'))))::jsonb ->> 'rate_in_force',
  public.e_w('15', '18'));
\else
-- Production: the renewal dialog writes roi_percentage directly (COO session).
SELECT public.e_ck('S6.ex15.renewrate', 'COO sets 18 on renewal (production: direct write)',
  public.e_run('postgres', 'e_coo', format('UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = %L RETURNING trim_scale(roi_percentage)::text', public.e_get('ex15_p0'))), '18');
\endif
\if :is_on
SELECT public.e_check('S6 the renewal rate change waits for the CFO (pending 18)', public.e_meta(public.e_id('ex15_p0')), 'typed_switch_off|18');
\endif

-- ===========================================================================
-- S7. Top-up (merge-pending-topups / approve-portfolio-topup: service-role principal update)
-- ===========================================================================
SELECT public.e_ck('S7.ex20.topup', 'top-up of 500,000 on the 20% portfolio: rate unchanged, no request',
  public.e_run('service_role', NULL, format('UPDATE public.investor_portfolios SET investment_amount = investment_amount + 500000 WHERE id = %L RETURNING trim_scale(roi_percentage)::text', public.e_get('ex20_p0'))), '20');
SELECT public.e_ck('S7.ex20.pay', 'next Returns cycle on 1,500,000 at 20%', public.e_pay(public.e_id('ex20_p0')), '300000');
SELECT public.e_ck('S7.new1.topup', 'top-up on the new partner''s portfolio keeps its rate',
  public.e_run('service_role', NULL, format('UPDATE public.investor_portfolios SET investment_amount = investment_amount + 500000 WHERE id = %L RETURNING trim_scale(roi_percentage)::text', public.e_get('s2_e_new1'))), public.e_w('10', '15'));
SELECT public.e_ck('S7.ex15.topup', 'top-up on the EXISTING 15 partner''s new portfolio keeps 15',
  public.e_run('service_role', NULL, format('UPDATE public.investor_portfolios SET investment_amount = investment_amount + 500000 WHERE id = %L RETURNING trim_scale(roi_percentage)::text', public.e_get('s2_e_ex15'))), '15');
SELECT public.e_ck('S7.ex15.pay', 'next Returns cycle on 1,500,000 at 15%', public.e_pay(public.e_id('s2_e_ex15')), '225000');
\if :has_phase
SELECT public.e_check('S7 top-ups queue no CFO request', split_part(public.e_meta(public.e_id('ex20_p0')), '|', 2) || ',' || split_part(public.e_meta(public.e_id('s2_e_new1')), '|', 2), '-,-');
\endif

-- ===========================================================================
-- S8. Split / lock (production tools, Partner Ops JWT)
-- ===========================================================================
SELECT public.e_set('s8_split', (public.e_run('authenticated', 'e_pops', format($$SELECT public.split_portfolio_principal(%L::uuid, 500000, 'e2e split for test')::text$$, public.e_get('ex20_p0'))))::jsonb ->> 'new_portfolio_id') IS NOT NULL AS x \gset
SELECT public.e_ck('S8.split', 'split child of the 20% portfolio keeps 20', public.e_roi(public.e_id('s8_split')), '20');
SELECT public.e_set('s8_split15', (public.e_run('authenticated', 'e_pops', format($$SELECT public.split_portfolio_principal(%L::uuid, 400000, 'e2e split of ex15')::text$$, public.e_get('s2_e_ex15'))))::jsonb ->> 'new_portfolio_id') IS NOT NULL AS x \gset
SELECT public.e_ck('S8.split15', 'split child of the EXISTING 15 partner''s portfolio keeps 15', public.e_roi(public.e_id('s8_split15')), '15');
SELECT public.e_set('s8_lock', (public.e_run('authenticated', 'e_pops', format($$SELECT public.lock_portfolio_principal(%L::uuid, 200000, 'e2e lock for test')::text$$, public.e_get('ex20_p0'))))::jsonb ->> 'locked_portfolio_id') IS NOT NULL AS x \gset
SELECT public.e_ck('S8.lock', 'locked child of the 20% portfolio keeps 20', public.e_roi(public.e_id('s8_lock')), '20');
SELECT public.e_set('s8_nsplit', (public.e_run('authenticated', 'e_pops', format($$SELECT public.split_portfolio_principal(%L::uuid, 300000, 'e2e split of new')::text$$, public.e_get('s2_e_new1'))))::jsonb ->> 'new_portfolio_id') IS NOT NULL AS x \gset
SELECT public.e_ck('S8.nsplit', 'split child of the NEW partner''s portfolio keeps its rate', public.e_roi(public.e_id('s8_nsplit')), public.e_w('10', '15'));
\if :is_on
SELECT public.e_check('S8 children are carried', public.e_meta(public.e_id('s8_split')) || ',' || public.e_meta(public.e_id('s8_lock')) || ',' || public.e_meta(public.e_id('s8_nsplit')),
  'carried|-,carried|-,carried|-');
-- ex20 redeems every portfolio except the split child: still existing through the carve-out chain.
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('e_ex20') AND id <> public.e_id('s8_split');
SELECT public.e_check('S8 ex20 holding only the split child: still EXISTING (quote me 20; new portfolio 20)',
  public.e_quote('e_ex20', 'me') || '/' || public.e_invite('s8_ex20_after', 'e_ex20', NULL), '20/20');
SELECT public.e_check('S8 the new partner''s split child does not make them existing (quote 10)', public.e_quote('e_new1', 'me'), '10');
\endif

-- ===========================================================================
-- S9. A partner who redeemed everything comes back
-- ===========================================================================
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('e_redeem');
SELECT public.e_ck('S9.redeem', 'EXISTING 20 who redeemed everything returns -> new portfolio', public.e_invite('s9_back', 'e_redeem', CASE WHEN :'mode' = 'base' THEN 15 END), public.e_w('10', '15'));
\if :is_on
SELECT public.e_check('S9 basis new; quote me 10; still in the frozen cohort list', public.e_meta(public.e_id('s9_back')) || '/' || public.e_quote('e_redeem', 'me') || '/'
  || (SELECT count(*) FROM public.partner_return_cohort WHERE partner_id = public.pid('e_redeem')), 'new|-/10/1');
\endif

-- ===========================================================================
-- S10. Payroll reinvestment (hr_pay_post_staff_reinvestment, service role)
-- ===========================================================================
SELECT public.e_ck('S10.emp', 'active employee salary reinvestment -> kind:stored', public.e_reinvest('s10_emp', 'e_emp'), 'portfolio_created:20');
SELECT public.e_ck('S10.emp.msg', 'notification quotes the stored rate',
  (SELECT (message LIKE '%earning 20\% per month.')::text FROM public.notifications WHERE user_id = public.pid('e_emp') AND title = 'Salary reinvested' ORDER BY created_at DESC LIMIT 1), 'true');
SELECT public.e_ck('S10.emp.topup', 'second payslip -> top-up of the same portfolio, rate kept', public.e_reinvest('s10_emp2', 'e_emp'), 'topup:20');
SELECT public.e_ck('S10.exemp', 'leaver''s final payslip (hr_staff inactive) -> 20', public.e_reinvest('s10_exemp', 'e_exemp', false), 'portfolio_created:20');
\if :is_on
SELECT public.e_check('S10 basis salary_reinvestment, no CFO request', public.e_meta(public.e_id('s10_emp')) || ',' || public.e_meta(public.e_id('s10_exemp')),
  'salary_reinvestment|-,salary_reinvestment|-');
SELECT public.e_check('S10 the leaver is NOT an employee for other portfolios (quote me 10)', public.e_quote('e_exemp', 'me'), '10');
\endif
SELECT public.e_ck('S10.pay', 'Returns cycle on the 200,000 salary portfolio', public.e_pay(public.e_id('s10_emp')), '40000');

-- ===========================================================================
-- S11. Promissory notes
-- ===========================================================================
-- (a) note_c partner already opened a 15 portfolio inside the window (S2). Time passes: the windows of note_b and note_c end.
\if :is_on
SELECT public.e_check('S11 time travel: note_b and note_c windows ended', public.e_close_window('note_b') || ',' || public.e_close_window('note_c'), 'true,true');
\endif
SELECT public.e_ck('S11.note_b.after', 'PRE-CUT-OFF NOTE partner, window ended, no note-funded portfolio -> new portfolio',
  public.e_invite('s11_b', 'e_note_b', CASE WHEN :'mode' = 'base' THEN 15 END), public.e_w('10', '15'));
SELECT public.e_ck('S11.note_c.after', 'PRE-CUT-OFF NOTE partner, window ended, note-funded portfolio still live -> new portfolio',
  public.e_invite('s11_c', 'e_note_c', CASE WHEN :'mode' = 'base' THEN 15 END), '15');
\if :is_on
SELECT public.e_check('S11 quotes: note_a (window open) 15, note_b 10, note_c 15', public.e_quote('e_note_a', 'me') || ',' || public.e_quote('e_note_b', 'me') || ',' || public.e_quote('e_note_c', 'me'), '15,10,15');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('e_note_c');
SELECT public.e_check('S11 note_c redeems the note-funded portfolios -> next portfolio 10', public.e_invite('s11_c2', 'e_note_c', NULL), '10');
\endif
-- (b) unlinked pre-cut-off note activated by token by an account whose phone differs from the note's.
\if :is_base
-- Production: activate-promissory-note links with the service role from the request's user_id.
SELECT public.e_ck('S11.tok.activate', 'token activation', public.e_run('service_role', NULL, format(
  $$UPDATE public.promissory_notes SET status = 'activated', partner_user_id = public.pid('e_tok') WHERE id = %L RETURNING 'linked'$$, public.e_get('note_tok'))), 'linked');
\else
\if :is_on
SELECT public.e_check('S11 old edge (service-role direct link) refused after the cut-off', left(public.e_run('service_role', NULL, format(
  $$UPDATE public.promissory_notes SET status = 'activated', partner_user_id = public.pid('e_tok') WHERE id = %L RETURNING 'linked'$$, public.e_get('note_tok'))), 10), 'ERR:42501:');
SELECT public.e_check('S11 D3: token activation without proof of the note''s phone -> NOTE_CONTACT_MISMATCH, nothing linked',
  public.e_run('authenticated', 'e_tok', format('SELECT public.activate_promissory_note(%L)::text', (SELECT activation_token FROM public.promissory_notes WHERE id = public.e_id('note_tok'))))
  || '/' || public.e_note_owner('note_tok'), 'ERR:42501:NOTE_CONTACT_MISMATCH/unlinked');
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome) VALUES ('+256701000777', public.pid('e_tok'), 'success');
\endif
SELECT public.e_ck('S11.tok.activate', 'token activation', CASE WHEN (public.e_run('authenticated', 'e_tok', format('SELECT public.activate_promissory_note(%L)::text',
  (SELECT activation_token FROM public.promissory_notes WHERE id = public.e_id('note_tok')))))::jsonb ->> 'success' = 'true' THEN 'linked' ELSE 'failed' END, 'linked');
\endif
SELECT public.e_ck('S11.tok.owner', 'note linked to the activating account', public.e_note_owner('note_tok'), 'E Tok');
SELECT public.e_ck('S11.tok.portfolio', 'token-activated pre-cut-off note partner (window open) -> new portfolio',
  public.e_invite('s11_tok', 'e_tok', CASE WHEN :'mode' = 'base' THEN 15 END), '15');
-- (c) a person signs up after the cut-off with the phone of an unlinked pre-cut-off note (production profile trigger links it).
SELECT public.e_person('e_signup', '+256701000555') IS NOT NULL AS x \gset
SELECT public.e_ck('S11.signup.link', 'profile phone match links the pre-cut-off note (on: HELD until proven, D3)', public.e_note_owner('note_signup'), public.e_w('unlinked', 'E Signup'));
\if :is_on
SELECT public.e_check('S11 the held link is recorded for Partner Ops; sign-up partner quotes 10',
  (SELECT count(*) FROM public.system_events WHERE event_type = 'promissory_note_link_held' AND metadata ->> 'note_id' = public.e_get('note_signup'))::text
  || '/' || public.e_quote('e_signup', 'me'), '1/10');
\endif
-- (d) notes written AFTER the cut-off carry the person's own rate.
SELECT public.e_note('pn_ex20', '+256701000020') IS NOT NULL AS x \gset
SELECT public.e_note('pn_emp', '+256701000040') IS NOT NULL AS x \gset
SELECT public.e_note('pn_new', '+256701000444') IS NOT NULL AS x \gset
SELECT public.e_ck('S11.pn.pledge', 'pledge monthly Returns: ex20 note / employee note / unknown person note',
  split_part(public.e_pledge('pn_ex20'), '/', 1) || ',' || split_part(public.e_pledge('pn_emp'), '/', 1) || ',' || split_part(public.e_pledge('pn_new'), '/', 1),
  public.e_w('200000,200000,100000', '150000,150000,150000'));
\if :has_phase
SELECT public.e_check('S11 post-cut-off note stamps (on) / legacy (never)', public.e_note_rate('pn_ex20') || ',' || public.e_note_rate('pn_emp') || ',' || public.e_note_rate('pn_new'),
  public.e_w('20/existing_partner,20/employee,10/new', '15/legacy,15/legacy,15/legacy'));
\endif
SELECT public.e_person('e_postnew', '+256701000444') IS NOT NULL AS x \gset
SELECT public.e_ck('S11.pn_new.link', 'the post-cut-off note links to the new account at sign-up (no window, no hold)', public.e_note_owner('pn_new'), 'E Postnew');
SELECT public.e_ck('S11.pn_new.portfolio', 'person of a post-cut-off note -> new portfolio (own rate; the note does not raise it)',
  public.e_invite('s11_pn', 'e_postnew', CASE WHEN :'mode' = 'base' THEN 15 END), public.e_w('10', '15'));
\if :has_phase
SELECT public.e_ck('S11.pn_new.keeps', 'the note keeps its stamped rate after the link', public.e_note_rate('pn_new'), public.e_w('10/new', '15/legacy'));
\endif

-- ===========================================================================
-- S12. Rent-facilitation reward (process-supporter-roi -> post_rent_facilitation_reward)
-- ===========================================================================
SELECT public.e_rr('rr_new', 'e_new1') IS NOT NULL AS x \gset
SELECT public.e_rr('rr_ex15', 'e_ex15') IS NOT NULL AS x \gset
SELECT public.e_rr('rr_emp', 'e_emp') IS NOT NULL AS x \gset
SELECT public.e_set('rw_pre', public.e_reward('rr_pre')) IS NOT NULL AS x \gset
SELECT public.e_set('rw_new', public.e_reward('rr_new')) IS NOT NULL AS x \gset
SELECT public.e_set('rw_ex15', public.e_reward('rr_ex15')) IS NOT NULL AS x \gset
SELECT public.e_set('rw_emp', public.e_reward('rr_emp')) IS NOT NULL AS x \gset
SELECT public.e_ck('S12.pre', 'funding made before the cut-off by the 20% partner: reward paid on 600,000', split_part(public.e_get('rw_pre'), '@', 1), '90000');
SELECT public.e_ck('S12.new', 'NEW supporter funding after the cut-off: reward paid', split_part(public.e_get('rw_new'), '@', 1), public.e_w('60000', '90000'));
SELECT public.e_ck('S12.ex15', 'EXISTING 15 supporter: reward paid', split_part(public.e_get('rw_ex15'), '@', 1), '90000');
SELECT public.e_ck('S12.emp', 'EMPLOYEE supporter: reward paid', split_part(public.e_get('rw_emp'), '@', 1), public.e_w('120000', '90000'));
\if :has_phase
SELECT public.e_check('S12 rate in the RPC answer (pre, new, ex15, emp)', split_part(public.e_get('rw_pre'), '@', 2) || ',' || split_part(public.e_get('rw_new'), '@', 2) || ','
  || split_part(public.e_get('rw_ex15'), '@', 2) || ',' || split_part(public.e_get('rw_emp'), '@', 2), public.e_w('15,10,15,20', '15,15,15,15'));
\endif
SELECT public.e_ck('S12.desc', 'wallet line text of the reward', public.e_get('rr_new_desc'),
  public.e_w('10% monthly reward (payment #1) on rent facilitation of UGX 600,000', '15% monthly reward (payment #1) on rent facilitation of UGX 600,000'));

-- ===========================================================================
-- S13. Quotes (partner_quote_rate)
-- ===========================================================================
\if :has_phase
SELECT public.e_ck('S13.public', 'public quote (anon)', public.e_quote(NULL, 'public'), public.e_w('10', '15'));
SELECT public.e_ck('S13.me', 'me: ex15, emp, emp15, new1, note_a, newtyped(own rate, not the approved 15)',
  public.e_quote('e_ex15', 'me') || ',' || public.e_quote('e_emp', 'me') || ',' || public.e_quote('e_emp15', 'me') || ',' || public.e_quote('e_new1', 'me') || ','
  || public.e_quote('e_note_a', 'me') || ',' || public.e_quote('e_newtyped', 'me'),
  public.e_w('15,20,20,10,15,10', '15,15,15,15,15,15'));
SELECT public.e_ck('S13.partner', 'partner staff quote a named partner (ex15, emp)', public.e_quote('e_pops', 'partner', 'e_ex15') || ',' || public.e_quote('e_pops', 'partner', 'e_emp'),
  public.e_w('15,20', '15,15'));
SELECT public.e_ck('S13.agent', 'a field agent cannot quote a named partner', public.e_quote('e_agent', 'partner', 'e_ex15'), 'ERR:42501:NOT_AUTHORIZED');
SELECT public.e_ck('S13.anon_me', 'anon cannot ask for "me"', public.e_quote(NULL, 'me'), 'ERR:42501:AUTH_REQUIRED');
\endif

-- ===========================================================================
-- S14. Consistency monitors after all paths
-- ===========================================================================
\if :has_phase
SELECT public.e_check('S14 partner_rate_conformance: no unexplained rate', (SELECT COALESCE(string_agg(issue, ','), 'empty') FROM public.partner_rate_conformance(NULL)), 'empty');
SELECT public.e_check('S14 assert_partner_return_policy_intact: all ok (release_ready aside)',
  (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok AND check_name <> 'release_ready'), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');
SELECT public.e_ck('S14.never_queue', 'CFO queue size', (SELECT count(*)::text FROM public.portfolio_rate_approvals WHERE status = 'pending'),
  public.e_w('4', '0'));
\endif

-- ===========================================================================
-- S15. Switched off again, then on again (mode on only)
-- ===========================================================================
\if :is_on
SELECT public.e_check('S15 CEO switches off; the cut-off stays',
  ((public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(false, NULL, 'e2e off again')::text$$))::jsonb ->> 'enabled')
  || '/' || ((SELECT cutoff_at::text FROM public.partner_return_policy) = public.e_get('cutoff'))::text, 'false/true');
SELECT public.e_check('S15 off: public quote 15; me (ex15, emp, new1) 15', public.e_quote(NULL, 'public') || '/' || public.e_quote('e_ex15', 'me') || ','
  || public.e_quote('e_emp', 'me') || ',' || public.e_quote('e_new1', 'me'), '15/15,15,15');
SELECT public.e_check('S15 off: NEW person no rate -> 15 switch_off', public.e_invite('s15_off1', 'e_off1', NULL) || '|' || public.e_meta(public.e_id('s15_off1')), '15|switch_off|-');
SELECT public.e_check('S15 off: EXISTING 20 partner no rate -> 15 (legacy for everyone, as production today)',
  public.e_invite('s15_ex20', 'e_ex20', NULL) || '|' || public.e_meta(public.e_id('s15_ex20')), '15|switch_off|-');
SELECT public.e_check('S15 off: typed 20 for a new person accepted, no CFO request', public.e_invite('s15_t20', 'e_invnew', 20) || '|' || public.e_meta(public.e_id('s15_t20')), '20|typed_switch_off|-');
SELECT public.e_check('S15 off: EMPLOYEE no rate -> 15; salary reinvestment still 20', public.e_invite('s15_emp', 'e_emp', NULL) || '/' || public.e_reinvest('s15_emp_sal', 'e_emp15'), '15/portfolio_created:20');
SELECT public.e_note('s15_note', '+256701000202') IS NOT NULL AS x \gset
SELECT public.e_check('S15 off: a new note -> 15 legacy (linked to newtyped by phone)', public.e_note_rate('s15_note') || '/' || public.e_note_owner('s15_note'), '15/legacy/E Newtyped');
SELECT public.e_rr('rr_off', 'e_new1') IS NOT NULL AS x \gset
SELECT public.e_check('S15 off: rent reward for a funding made while off -> 15', public.e_reward('rr_off'), '90000@15');
SELECT public.e_check('S15 off: a renewal rate change applies directly (recorded as an approved request)',
  ((public.e_run('authenticated', 'e_coo', format('SELECT public.set_portfolio_renewal_rate(%L::uuid, 12)::text', public.e_get('s2_e_ex15'))))::jsonb ->> 'rate_in_force')
  || '/' || public.e_last_req('s2_e_ex15'),
  '12/approved:true');
SELECT public.e_check('S15 off: requests queued while on stay pending (ex20 lowering, emp 15, renewal 18, invite 15)',
  (SELECT count(*)::text FROM public.portfolio_rate_approvals WHERE status = 'pending'), '4');
\endif
\if :is_on
SELECT public.e_check('S15 CEO switches on again: cut-off and cohort unchanged',
  ((public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(true, NULL, 'e2e on again')::text$$))::jsonb ->> 'enabled')
  || '/' || ((SELECT cutoff_at::text FROM public.partner_return_policy) = public.e_get('cutoff'))::text
  || '/' || (SELECT count(*) FROM public.partner_return_cohort c JOIN public.profiles p ON p.id = c.partner_id WHERE p.full_name LIKE 'E %'), 'true/true/6');
SELECT public.e_check('S15 on again: the person who got 15 while off is NEW (quote 10; their 15 portfolio keeps 15)',
  public.e_quote('e_off1', 'me') || '/' || public.e_roi(public.e_id('s15_off1')), '10/15');
SELECT public.e_check('S15 on again: ex20 back to 20; the 15 portfolio opened while off keeps 15', public.e_quote('e_ex20', 'me') || '/' || public.e_roi(public.e_id('s15_ex20')), '20/15');
-- Invite opened while ON, claimed while OFF (activate-supporter): which rate does the existing 20 partner get?
-- Phase 6 F4: an invite opened while on has no person yet (new_no_investor, 10); claimed while the switch is off it is
-- decided as production decides today: legacy 15 (switch_off), whoever claims it. A typed rate waiting for the CFO on
-- such an invite is measured again against that legacy rate.
SELECT public.e_ck('S15.inv_on', 'invite opened while on (no investor)', public.e_open_invite('inv_onoff', NULL), '10');
SELECT public.e_person('e_f4new', '+256701000401') IS NOT NULL AS x \gset
SELECT public.e_person('e_f4typed', '+256701000402') IS NOT NULL AS x \gset
SELECT public.e_ck('S15.inv_on2', 'second invite opened while on (no investor)', public.e_open_invite('inv_onoff2', NULL), '10');
SELECT public.e_ck('S15.inv_on3', 'third invite opened while on, staff typed 15 (waits for the CFO)', public.e_open_invite('inv_onoff3', 15), '10');
SELECT public.e_check('S15 (F4) invites opened while on: basis new_no_investor, the typed 15 pending for the CFO',
  public.e_meta(public.e_id('inv_onoff')) || ',' || public.e_meta(public.e_id('inv_onoff2')) || ',' || public.e_meta(public.e_id('inv_onoff3')),
  'new_no_investor|-,new_no_investor|-,new_no_investor|15');
SELECT public.e_check('S15 switch off again for the claim', (public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(false)::text$$))::jsonb ->> 'enabled', 'false');
SELECT public.e_ck('S15.inv_claim_off', 'claimed while OFF by the EXISTING 20 partner -> stored (production today gives 15)', public.e_claim('inv_onoff', 'e_ex20'), '15');
SELECT public.e_ck('S15.inv_claim_off2', 'claimed while OFF by a NEW person -> stored (production today gives 15)', public.e_claim('inv_onoff2', 'e_f4new'), '15');
SELECT public.e_ck('S15.inv_claim_off3', 'typed-15 invite claimed while OFF by a NEW person -> stored', public.e_claim('inv_onoff3', 'e_f4typed'), '15');
SELECT public.e_check('S15 (F4) claimed while off: re-stamped legacy (switch_off); the typed-15 request is re-measured (requested 15 > in force 15 / standard 15) and stays pending',
  public.e_meta(public.e_id('inv_onoff')) || ',' || public.e_meta(public.e_id('inv_onoff2')) || ',' || public.e_meta(public.e_id('inv_onoff3')) || '/'
  || (SELECT trim_scale(requested_rate) || '>' || trim_scale(rate_in_force) || '/' || trim_scale(standard_rate) FROM public.portfolio_rate_approvals
       WHERE portfolio_id = public.e_id('inv_onoff3') AND status = 'pending'),
  -- Phase 6 tester finding: the re-measured request asks for the rate already in force (a no-op left in the CFO queue).
  'switch_off|-,switch_off|-,switch_off|15/15>15/15');
SELECT public.e_ck('S15.pay.inv_claim_off', 'Returns cycle on the invite claimed while off (1,000,000 at 15)', public.e_pay(public.e_id('inv_onoff')), '150000');
SELECT public.e_check('S15 final: back on', (public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(true)::text$$))::jsonb ->> 'enabled', 'true');
SELECT public.e_check('S15 (F4) back on: the claimed invites keep 15; the new claimant is NEW (quote 10), ex20 still 20',
  public.e_roi(public.e_id('inv_onoff')) || ',' || public.e_roi(public.e_id('inv_onoff2')) || '/' || public.e_quote('e_f4new', 'me') || ',' || public.e_quote('e_ex20', 'me'), '15,15/10,20');
SELECT public.e_check('S15 final: conformance empty', (SELECT COALESCE(string_agg(issue || ':' || COALESCE(rate_basis, '-'), ','), 'empty') FROM public.partner_rate_conformance(NULL)), 'empty');
\endif

-- ===========================================================================
-- S16. Phase 6 F1: an existing partner who is also staff keeps their own rate after leaving HR
--      (ex20hr: pre-cut-off 20 + staff; emp15: pre-cut-off 15 + staff; control emp: staff, never an existing partner)
-- ===========================================================================
SELECT public.e_ck('S16.ex20hr.new', 'EXISTING 20 partner who is staff, new portfolio (no rate) -> stored',
  public.e_invite('s16_ex20hr', 'e_ex20hr', CASE WHEN :'mode' = 'base' THEN 15 END), public.e_w('20', '15'));
\if :is_on
CREATE OR REPLACE FUNCTION public.e_stamp(p_key text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT rate_basis || '|' || COALESCE(rate_existing_at_decision::text, 'null') FROM public.investor_portfolios WHERE id = public.e_id(p_key) $$;
SELECT public.e_check('S16 stamps (basis|rate_existing_at_decision): ex20hr employee|true; emp15 (S2) employee|true; emp, no pre-cut-off portfolio (S2) employee|false; salary reinvestment (S10) salary_reinvestment|false',
  public.e_stamp('s16_ex20hr') || ',' || public.e_stamp('s2_e_emp15') || ',' || public.e_stamp('s2_e_emp') || ',' || public.e_stamp('s10_emp'),
  'employee|true,employee|true,employee|false,salary_reinvestment|false');
SELECT public.e_check('S16 while still staff: quotes ex20hr 20, emp15 20, emp 20', public.e_quote('e_ex20hr', 'me') || ',' || public.e_quote('e_emp15', 'me') || ',' || public.e_quote('e_emp', 'me'), '20,20,20');
\endif
-- Both redeem their pre-cut-off portfolios, then leave HR; emp leaves HR too.
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id IN (public.e_id('ex20hr_p0'), public.e_id('emp15_p0'));
UPDATE public.hr_staff SET active = false WHERE user_id IN (public.pid('e_ex20hr'), public.pid('e_emp15'), public.pid('e_emp'));
SELECT public.e_ck('S16.ex20hr.after', 'EXISTING 20 partner left HR, pre-cut-off portfolio redeemed, new portfolio -> stored',
  public.e_invite('s16_ex20hr2', 'e_ex20hr', CASE WHEN :'mode' = 'base' THEN 15 END), public.e_w('20', '15'));
SELECT public.e_ck('S16.emp15.after', 'EXISTING 15 partner left HR, pre-cut-off portfolio redeemed, new portfolio -> stored',
  public.e_invite('s16_emp15', 'e_emp15', CASE WHEN :'mode' = 'base' THEN 15 END), '15');
SELECT public.e_ck('S16.pay.ex20hr', 'Returns cycle on the 1,000,000 portfolio opened after leaving HR', public.e_pay(public.e_id('s16_ex20hr2')), public.e_w('200000', '150000'));
SELECT public.e_ck('S16.pay.emp15', 'Returns cycle on the 1,000,000 portfolio opened after leaving HR', public.e_pay(public.e_id('s16_emp15')), '150000');
\if :is_on
SELECT public.e_check('S16 after leaving HR: bases existing_partner x2 (no CFO request); quotes ex20hr 20, emp15 15; control emp (never an existing partner) 10',
  public.e_meta(public.e_id('s16_ex20hr2')) || ',' || public.e_meta(public.e_id('s16_emp15')) || '/'
  || public.e_quote('e_ex20hr', 'me') || ',' || public.e_quote('e_emp15', 'me') || ',' || public.e_quote('e_emp', 'me'),
  'existing_partner|-,existing_partner|-/20,15,10');
SELECT public.e_check('S16 the staff-time portfolios keep their stored 20 (no rate change, no request)',
  public.e_roi(public.e_id('s16_ex20hr')) || ',' || public.e_roi(public.e_id('s2_e_emp15')) || '/' || split_part(public.e_meta(public.e_id('s16_ex20hr')), '|', 2), '20,20/-');
SELECT public.e_check('S16 final: conformance empty; assert all ok',
  (SELECT COALESCE(string_agg(issue || ':' || COALESCE(rate_basis, '-'), ','), 'empty') FROM public.partner_rate_conformance(NULL)) || '/'
  || (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok AND check_name <> 'release_ready'), 'all ok') FROM public.assert_partner_return_policy_intact()),
  'empty/all ok');
\endif

-- ===========================================================================
-- S17. Phase 6 G2 / G3: an off period after the cut-off (mode on only)
--   G2  g2ex (existing 20) opens two portfolios while off, then redeems the pre-cut-off one; back on, still existing.
--       g2new opens one while off: new when the switch is back on.
--   G3  invites opened while off after the cut-off and claimed while on are decided for the claimant (an offer made
--       after the cut-off is not honoured, D14); a rate typed while off waits for the CFO. The invite opened before the
--       cut-off (S0) keeps 15.
-- ===========================================================================
\if :is_on
SELECT public.e_check('S17 CEO switches off; the cut-off stays',
  ((public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(false, NULL, 'e2e G2/G3 off period')::text$$))::jsonb ->> 'enabled')
  || '/' || ((SELECT cutoff_at::text FROM public.partner_return_policy) = public.e_get('cutoff'))::text, 'false/true');
SELECT public.e_check('S17 (G2) off: the EXISTING 20 partner opens one portfolio with no rate and one typed 20 -> 15 switch_off / 20 typed_switch_off, both flagged existing; a NEW person -> 15 switch_off, flagged not existing; no CFO request',
  public.e_invite('s17_ex_a', 'e_g2ex', NULL) || '|' || public.e_stamp('s17_ex_a') || ',' || public.e_invite('s17_ex_b', 'e_g2ex', 20) || '|' || public.e_stamp('s17_ex_b') || ','
  || public.e_invite('s17_new', 'e_g2new', NULL) || '|' || public.e_stamp('s17_new') || '/'
  || split_part(public.e_meta(public.e_id('s17_ex_a')), '|', 2) || split_part(public.e_meta(public.e_id('s17_ex_b')), '|', 2) || split_part(public.e_meta(public.e_id('s17_new')), '|', 2),
  '15|switch_off|true,20|typed_switch_off|true,15|switch_off|false/---');
SELECT public.e_check('S17 (G3) off: back-office invites opened after the cut-off: no rate 15, typed 20, no rate, no rate (bases switch_off / typed_switch_off)',
  public.e_open_invite('g3_off', NULL) || ',' || public.e_open_invite('g3_off_t', 20) || ',' || public.e_open_invite('g3_off_ex', NULL) || ',' || public.e_open_invite('g3_offoff', NULL)
  || '/' || public.e_meta(public.e_id('g3_off')) || ',' || public.e_meta(public.e_id('g3_off_t')),
  '15,20,15,15/switch_off|-,typed_switch_off|-');
SELECT public.e_check('S17 (G3) an invite opened and claimed while off (new person): keeps 15 switch_off, flagged not existing',
  public.e_claim('g3_offoff', 'e_g3c') || '|' || public.e_stamp('g3_offoff'), '15|switch_off|false');
SELECT public.e_check('S17 (G2) off: the EXISTING partner redeems the pre-cut-off portfolio (only off-period portfolios left)',
  public.e_set_status(public.e_id('g2ex_p0'), 'redeemed'), 'redeemed');
SELECT public.e_check('S17 CEO switches on again: cut-off unchanged',
  ((public.e_run('authenticated', 'ceo', $$SELECT public.set_partner_return_policy(true, NULL, 'e2e G2/G3 on again')::text$$))::jsonb ->> 'enabled')
  || '/' || ((SELECT cutoff_at::text FROM public.partner_return_policy) = public.e_get('cutoff'))::text, 'true/true');
SELECT public.e_check('S17 (G2) on again: quotes EXISTING (holds only off-period portfolios) 20, NEW off-period person 10',
  public.e_quote('e_g2ex', 'me') || ',' || public.e_quote('e_g2new', 'me'), '20,10');
SELECT public.e_check('S17 (G2) on again: next portfolios (no rate): EXISTING 20 existing_partner flagged true; NEW 10 new flagged false; no CFO request',
  public.e_invite('s17_ex_c', 'e_g2ex', NULL) || '|' || public.e_stamp('s17_ex_c') || ',' || public.e_invite('s17_new2', 'e_g2new', NULL) || '|' || public.e_stamp('s17_new2') || '/'
  || split_part(public.e_meta(public.e_id('s17_ex_c')), '|', 2) || split_part(public.e_meta(public.e_id('s17_new2')), '|', 2),
  '20|existing_partner|true,10|new|false/--');
SELECT public.e_check('S17 (G2) the off-period portfolios keep their stored rates (15, 20, 15)',
  public.e_roi(public.e_id('s17_ex_a')) || ',' || public.e_roi(public.e_id('s17_ex_b')) || ',' || public.e_roi(public.e_id('s17_new')), '15,20,15');
SELECT public.e_check('S17 (G3) invite opened while off after the cut-off, claimed while on by a NEW person: 10 new, flagged not existing, no CFO request',
  public.e_claim('g3_off', 'e_g3a') || '|' || public.e_stamp('g3_off') || '|' || split_part(public.e_meta(public.e_id('g3_off')), '|', 2), '10|new|false|-');
SELECT public.e_check('S17 (G3) typed-20 invite opened while off, claimed while on by a NEW person: 10 in force',
  public.e_claim('g3_off_t', 'e_g3b'), '10');
-- (the request is read in its own statement: a scalar subquery runs as an init plan, before the claim in the same SELECT)
SELECT public.e_check('S17 (G3) ... the typed 20 waits for the CFO (basis new; requested 20 > in force 10 / standard 10, new_portfolio)',
  public.e_meta(public.e_id('g3_off_t')) || '/'
  || (SELECT trim_scale(requested_rate) || '>' || trim_scale(rate_in_force) || '/' || trim_scale(standard_rate) || ':' || source FROM public.portfolio_rate_approvals
       WHERE portfolio_id = public.e_id('g3_off_t') AND status = 'pending'),
  'new|20/20>10/10:new_portfolio');
SELECT public.e_check('S17 (G3) the CFO sees the typed 20 in the pending queue',
  public.e_run('authenticated', 'cfo', format($$SELECT count(*)::text FROM public.list_portfolio_rate_requests('pending') WHERE portfolio_id = %L::uuid AND requested_rate = 20$$, public.e_get('g3_off_t'))), '1');
SELECT public.e_check('S17 (G3) invite opened while off, claimed while on by the EXISTING partner g2ex: 20 existing_partner, flagged existing',
  public.e_claim('g3_off_ex', 'e_g2ex') || '|' || public.e_stamp('g3_off_ex'), '20|existing_partner|true');
SELECT public.e_check('S17 (G3, D14) invite opened BEFORE the cut-off, claimed while on by a NEW person: keeps 15 switch_off (offer honoured), no CFO request',
  public.e_claim('g3_pre', 'e_g3d') || '|' || public.e_meta(public.e_id('g3_pre')), '15|switch_off|-');
SELECT public.e_check('S17 (G3) quotes of the claimants: g3a, g3b, g3c, g3d all NEW (10)',
  public.e_quote('e_g3a', 'me') || ',' || public.e_quote('e_g3b', 'me') || ',' || public.e_quote('e_g3c', 'me') || ',' || public.e_quote('e_g3d', 'me'), '10,10,10,10');
SELECT public.e_check('S17 Returns cycles (1,000,000 each): g3_off at 10, g3_off_t at 10 (typed 20 not approved), g3_pre at 15, s17_ex_c at 20',
  public.e_pay(public.e_id('g3_off')) || ',' || public.e_pay(public.e_id('g3_off_t')) || ',' || public.e_pay(public.e_id('g3_pre')) || ',' || public.e_pay(public.e_id('s17_ex_c')),
  '100000,100000,150000,200000');
SELECT public.e_check('S17 final: conformance empty; assert all ok',
  (SELECT COALESCE(string_agg(issue || ':' || COALESCE(rate_basis, '-'), ','), 'empty') FROM public.partner_rate_conformance(NULL)) || '/'
  || (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok AND check_name <> 'release_ready'), 'all ok') FROM public.assert_partner_return_policy_intact()),
  'empty/all ok');
\endif

-- ===========================================================================
SELECT 'SUMMARY ' || :'mode' || ' ' || count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' FROM public._e_results;
