-- Shared helpers for the Phase 2 tests (phase2_test.sql, race_run_phase2.sh, phase2_timing.sh).
-- LOCAL THROWAWAY CLUSTER ONLY. Load after race_stub.sql + race_stub_phase2.sql + both migrations.
-- ===========================================================================
-- Helpers (same contract as phase1_persona_test.sql)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public._t_results (n bigserial PRIMARY KEY, name text, ok boolean, got text, want text);
CREATE TABLE IF NOT EXISTS public._t_ids (k text PRIMARY KEY, id uuid);
CREATE TABLE IF NOT EXISTS public._t_vars (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT, UPDATE ON public._t_results, public._t_ids, public._t_vars TO PUBLIC;
GRANT USAGE ON SEQUENCE public._t_results_n_seq TO PUBLIC;
-- Runs p_sql; PASS when it succeeds (effects kept), FAIL with the error otherwise.
CREATE OR REPLACE FUNCTION public.t_runs(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  EXECUTE p_sql;
  RETURN public.t_check(p_name, 'ok', 'ok');
EXCEPTION WHEN others THEN
  RETURN public.t_check(p_name, SQLSTATE || ': ' || SQLERRM, 'ok');
END $$;
-- Informational line (not counted): what p_sql does.
CREATE OR REPLACE FUNCTION public.t_info(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'T_NO_ERROR';
  EXCEPTION WHEN others THEN
    RETURN 'INFO  ' || p_name || ': ' || CASE WHEN SQLERRM = 'T_NO_ERROR' THEN 'runs (rolled back)' ELSE SQLSTATE || ' ' || SQLERRM END;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.t_check(p_name text, p_got text, p_want text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ok boolean := p_got IS NOT DISTINCT FROM p_want;
BEGIN
  INSERT INTO public._t_results (name, ok, got, want) VALUES (p_name, v_ok, p_got, p_want);
  RETURN CASE WHEN v_ok THEN 'PASS  ' || p_name
              ELSE 'FAIL  ' || p_name || '  got [' || COALESCE(p_got, '<null>') || '] want [' || COALESCE(p_want, '<null>') || ']' END;
END $$;
CREATE OR REPLACE FUNCTION public.t_raises(p_name text, p_sql text, p_like text DEFAULT NULL) RETURNS text
 LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'T_NO_ERROR';
  EXCEPTION WHEN others THEN
    IF SQLERRM = 'T_NO_ERROR' THEN
      RETURN public.t_check(p_name, 'no error (statement succeeded; rolled back)', 'error' || COALESCE(' ' || p_like, ''));
    ELSIF p_like IS NULL OR SQLSTATE = p_like OR SQLERRM ILIKE p_like THEN
      RETURN public.t_check(p_name, 'error', 'error');
    ELSE
      RETURN public.t_check(p_name, SQLSTATE || ': ' || SQLERRM, 'error ' || p_like);
    END IF;
  END;
END $$;
-- Runs p_sql and always rolls it back; returns 'ok' or 'SQLSTATE: message' (for exact error checks).
CREATE OR REPLACE FUNCTION public.t_err(p_sql text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'T_NO_ERROR';
  EXCEPTION WHEN others THEN
    RETURN CASE WHEN SQLERRM = 'T_NO_ERROR' THEN 'ok' ELSE SQLSTATE || ': ' || SQLERRM END;
  END;
END $$;
CREATE OR REPLACE FUNCTION public.tid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public._t_ids WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION public.t_as(p_user text) RETURNS void LANGUAGE sql VOLATILE AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(public.pid(p_user)::text, ''), false),
         set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN '' ELSE 'authenticated' END, false),
         set_config('request.jwt.claims', '', false) $$;
CREATE OR REPLACE FUNCTION public.t_vset(p_k text, p_v text) RETURNS void LANGUAGE sql VOLATILE AS $$
  INSERT INTO public._t_vars VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v $$;
CREATE OR REPLACE FUNCTION public.t_v(p_k text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT v FROM public._t_vars WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION public.t_desc(p_id uuid) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(trim_scale(ip.roi_percentage)::text, '-') || '|' || COALESCE(ip.rate_basis, '-') || '|'
      || COALESCE(trim_scale(ip.entitled_rate)::text, '-') || '|'
      || COALESCE((SELECT string_agg(trim_scale(a.requested_rate)::text, ',' ORDER BY a.requested_at)
                     FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id AND a.status = 'pending'), '-')
    FROM public.investor_portfolios ip WHERE ip.id = p_id $$;
CREATE OR REPLACE FUNCTION public.t_rate(p_person text) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT trim_scale(r.rate)::text || '|' || r.basis FROM public.partner_rates_for(ARRAY[public.pid(p_person)]) r $$;
CREATE OR REPLACE FUNCTION public.t_emails(p_like text DEFAULT '%') RETURNS integer LANGUAGE sql VOLATILE AS
  $$ SELECT count(*)::int FROM public._email_outbox WHERE payload ->> 'subject' LIKE p_like $$;
-- The per-person rate lock (Phase 1 partner_rate_lock): pg_advisory_xact_lock(hashtext('partner-rate'), hashtext(id::text) & 255),
-- one of 256 buckets. pg_locks shows the two-int4 form as classid = key 1 (as oid), objid = key 2, objsubid = 2
-- (the one-bigint form is objsubid = 1); checked on PG 18.
CREATE OR REPLACE FUNCTION public.t_rate_bucket(p_person text) RETURNS integer LANGUAGE sql IMMUTABLE AS
  $$ SELECT hashtext(public.pid(p_person)::text) & 255 $$;
CREATE OR REPLACE FUNCTION public.t_rate_bucket_of(p_id uuid) RETURNS integer LANGUAGE sql IMMUTABLE AS
  $$ SELECT hashtext(p_id::text) & 255 $$;
-- The partner-rate buckets this session holds right now (sorted), and how many advisory locks of any kind.
CREATE OR REPLACE FUNCTION public.t_rate_buckets_held() RETURNS integer[] LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(array_agg(l.objid::bigint::int ORDER BY l.objid), '{}'::integer[]) FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 2
     AND l.classid = hashtext('partner-rate')::oid $$;
CREATE OR REPLACE FUNCTION public.t_advisory_held() RETURNS integer LANGUAGE sql VOLATILE AS $$
  SELECT count(*)::int FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() $$;
CREATE OR REPLACE FUNCTION public.t_holds_rate_lock(p_person text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT public.t_rate_bucket(p_person) = ANY (public.t_rate_buckets_held()) $$;
-- The wallet text process-supporter-roi (supabase/functions/process-supporter-roi/index.ts, lines 147-148) sends today:
--   `15% monthly reward (payment #${n}) on rent facilitation of UGX ${Number(rent).toLocaleString()}` [+ ` (managed by ${name})`]
-- toLocaleString() on Deno is en-US grouping, the same as to_char(rent, 'FM999,999,999,990') for whole shillings.
CREATE OR REPLACE FUNCTION public.t_edge_reward_text(p_n integer, p_rent numeric, p_proxy text DEFAULT NULL) RETURNS text
 LANGUAGE sql IMMUTABLE AS $$
  SELECT format('15%% monthly reward (payment #%s) on rent facilitation of UGX %s', p_n, to_char(p_rent, 'FM999,999,999,990'))
         || CASE WHEN p_proxy IS NULL THEN '' ELSE format(' (managed by %s)', p_proxy) END $$;
-- Rates stored since p_since, as text (no trim_scale): how many print with a decimal point, out of how many.
--   p: portfolios (roi_percentage), c: commitments, l: funding lines, h: supported houses (monthly_rate)
CREATE OR REPLACE FUNCTION public.t2_raw_since(p_since timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'p:' || (SELECT count(*) FILTER (WHERE ip.roi_percentage::text LIKE '%.%') || '/' || count(*) FROM public.investor_portfolios ip WHERE ip.rate_decided_at >= p_since)
      || ' c:' || (SELECT count(*) FILTER (WHERE c.monthly_rate::text LIKE '%.%') || '/' || count(*) FROM public.partner_self_commitments c WHERE c.created_at >= p_since)
      || ' l:' || (SELECT count(*) FILTER (WHERE l.monthly_rate::text LIKE '%.%') || '/' || count(*) FROM public.partner_self_funding_lines l WHERE l.created_at >= p_since)
      || ' h:' || (SELECT count(*) FILTER (WHERE h.monthly_rate::text LIKE '%.%') || '/' || count(*) FROM public.partner_supported_houses h WHERE h.created_at >= p_since) $$;
-- pay_partner_self_cycles builds its wallet line as  c.monthly_rate || '% monthly returns on self-managed funding (cycle ending ...'
CREATE OR REPLACE FUNCTION public.t2_cycle_texts(p_since timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(DISTINCT c.monthly_rate || '% monthly returns on self-managed funding', ' | ')
    FROM public.partner_self_commitments c WHERE c.created_at >= p_since $$;

-- A person: auth user + profile (email; optional phone) + agreement.
--   p_agreement 'countersigned' (default; not on the signer list), 'signed' (signed, not countersigned), 'none'.
CREATE OR REPLACE FUNCTION public.t2_person(p_name text, p_agreement text DEFAULT 'countersigned', p_phone text DEFAULT NULL) RETURNS uuid
 LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (public.pid(p_name), p_name || '@partner.test') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, full_name, email, phone) VALUES (public.pid(p_name), 'Partner ' || p_name, p_name || '@partner.test', p_phone)
  ON CONFLICT (id) DO NOTHING;
  IF p_agreement = 'countersigned' THEN
    INSERT INTO public.partner_agreements (partner_id, status, partner_signature_data_url, countersigned_at, partnership_amount)
    VALUES (public.pid(p_name), 'countersigned', 'data:x', now(), 0) ON CONFLICT (partner_id) DO NOTHING;
  ELSIF p_agreement = 'signed' THEN
    INSERT INTO public.partner_agreements (partner_id, status, partner_signature_data_url, countersigned_at, partnership_amount)
    VALUES (public.pid(p_name), 'signed', 'data:x', NULL, 0) ON CONFLICT (partner_id) DO NOTHING;
  END IF;
  RETURN public.pid(p_name);
END $$;
-- A portfolio written directly (typed rate; the gate decides as for any insert).
CREATE OR REPLACE FUNCTION public.t2_port(p_person text, p_rate numeric DEFAULT NULL, p_status text DEFAULT 'active') RETURNS uuid
 LANGUAGE sql AS $$
  INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin,
                                         status, roi_percentage)
  VALUES (public.pid(p_person), public.pid('agent1'), 'T2-' || p_person || '-' || substr(md5(random()::text), 1, 6), 100000, 12, '1111',
          p_status, p_rate) RETURNING id $$;
CREATE OR REPLACE FUNCTION public.t2_house(p_rent integer DEFAULT 200000, p_verified boolean DEFAULT true) RETURNS uuid
 LANGUAGE plpgsql AS $$
DECLARE v_l uuid; v_h uuid;
BEGIN
  INSERT INTO public.landlords (name, phone) VALUES ('Landlord ' || substr(md5(random()::text), 1, 4), '0700' || (100000 + (random() * 899999)::int))
  RETURNING id INTO v_l;
  INSERT INTO public.house_listings (landlord_id, agent_id, title, monthly_rent, district, verified)
  VALUES (v_l, public.pid('agent1'), 'House ' || substr(md5(random()::text), 1, 5), p_rent, 'Wakiso', p_verified) RETURNING id INTO v_h;
  RETURN v_h;
END $$;
CREATE OR REPLACE FUNCTION public.t2_houses(p_n integer, p_rent integer DEFAULT 200000) RETURNS uuid[] LANGUAGE sql AS
  $$ SELECT array_agg(public.t2_house(p_rent)) FROM generate_series(1, p_n) $$;
CREATE OR REPLACE FUNCTION public.t2_plan(p_amount numeric DEFAULT 150000) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.rent_requests (tenant_id, landlord_id, rent_amount, status, approved_at, request_city)
  VALUES (gen_random_uuid(), gen_random_uuid(), p_amount, 'approved', now(), 'Kampala') RETURNING id $$;

-- The portfolio and everything that pays its Returns:
--   rate|basis|e<entitled>|c:<commitment rates>|l:<line rates>|h:<house rates>|req:<pending CFO requests>|ret:<rate the RPC returned>
CREATE OR REPLACE FUNCTION public.t2_fam(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT trim_scale(ip.roi_percentage) || '|' || COALESCE(ip.rate_basis, '-') || '|e' || COALESCE(trim_scale(ip.entitled_rate)::text, '-')
      || '|c:' || COALESCE((SELECT string_agg(DISTINCT trim_scale(c.monthly_rate)::text, ',') FROM public.funder_pending_portfolios f
                              JOIN public.partner_self_commitments c ON c.id = f.commitment_id WHERE f.portfolio_id = ip.id), '-')
      || '|l:' || COALESCE((SELECT string_agg(DISTINCT trim_scale(l.monthly_rate)::text, ',') FROM public.funder_pending_portfolios f
                              JOIN public.partner_self_funding_lines l ON l.commitment_id = f.commitment_id WHERE f.portfolio_id = ip.id), '-')
      || '|h:' || COALESCE((SELECT string_agg(DISTINCT trim_scale(h.monthly_rate)::text, ',') FROM public.partner_supported_houses h
                             WHERE h.portfolio_id = ip.id), '-')
      || '|req:' || (SELECT count(*) FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = ip.id AND a.status = 'pending')
      || '|ret:' || COALESCE(NULLIF(current_setting('t.ret', true), ''), '-')
    FROM public.investor_portfolios ip WHERE ip.id = p_id $$;
CREATE OR REPLACE FUNCTION public.t2_ret(p_res jsonb) RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_res ->> 'portfolio_id' IS NULL THEN RAISE EXCEPTION 'T2_NO_PORTFOLIO: %', p_res; END IF;
  PERFORM set_config('t.ret', COALESCE(trim_scale((p_res ->> 'roi_percentage')::numeric)::text, '-'), false);
  PERFORM public.t_vset('last_res', p_res::text);
  RETURN (p_res ->> 'portfolio_id')::uuid;
END $$;

-- The creation paths, each returning the new portfolio id (the RPC's own roi_percentage goes to t.ret).
CREATE OR REPLACE FUNCTION public.t2_fcpp(p_person text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_person); RETURN public.t2_ret(public.funder_create_pending_portfolio(100000)); END $$;
CREATE OR REPLACE FUNCTION public.t2_psm(p_person text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.t_as('pops');
  RETURN public.t2_ret(public.psm_confirm_commitment_for(public.pid(p_person), ARRAY[public.t2_plan(150000), public.t2_plan(250000)],
                                                       1, NULL, public.pid('pops'), NULL, 'float'));
END $$;
CREATE OR REPLACE FUNCTION public.t2_psh4(p_person text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_person); RETURN public.t2_ret(public.partner_support_houses(public.t2_houses(2), 1, NULL::text, NULL::uuid)); END $$;
-- The 3-argument overload cannot be called by name (see the finding); t_psh3 is a byte-for-byte copy of its body.
CREATE OR REPLACE FUNCTION public.t2_psh3(p_person text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_person); RETURN public.t2_ret(public.t_psh3(public.t2_houses(2), 1, NULL::text)); END $$;
CREATE OR REPLACE FUNCTION public.t2_cpp(p_person text, p_rate numeric DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM public.t_as('pops');
  SELECT c.portfolio_id INTO v FROM public.create_pending_portfolio(public.pid(p_person), 100000, 12, p_rate, 'monthly_payout', 'nick', repeat('t', 40)) c;
  PERFORM set_config('t.ret', '-', false);
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.t2_cs(p_person text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_have numeric;
BEGIN
  PERFORM public.t_as('pops');
  SELECT existing_total INTO v_have FROM public._partner_contract_coverage(public.pid(p_person));
  RETURN public.t2_ret(public.countersign_prepare_support(public.pid(p_person), v_have + 100000, 'company_managed', 'A', public.pid('pops')));
END $$;
CREATE OR REPLACE FUNCTION public.t2_sum(p_person text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as('pops'); RETURN trim_scale((public.get_countersign_summary(public.pid(p_person)) ->> 'roi_percentage')::numeric)::text; END $$;
-- Payroll fixture: an approved run with one REINVEST line for the person's payslip.
CREATE OR REPLACE FUNCTION public.t2_payslip(p_person text, p_amount numeric DEFAULT 200000, p_active boolean DEFAULT true) RETURNS uuid
 LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION public.t2_pay(p_person text, p_active boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(NULL); RETURN public.t2_ret(public.hr_pay_post_staff_reinvestment(public.t2_payslip(p_person, 200000, p_active))); END $$;
CREATE OR REPLACE FUNCTION public.t2_conf() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(issue || ':' || COALESCE(rate_basis, '-'), ',' ORDER BY issue), 'empty') FROM public.partner_rate_conformance(NULL) $$;

-- Production texts kept for parity checks (read 2026-11-06).
CREATE OR REPLACE FUNCTION public._t_old_summary() RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public' AS $f$
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
$f$;
CREATE OR REPLACE FUNCTION public._t_old_pool_stats() RETURNS json LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE
  total_in numeric;
  total_out numeric;
  total_withdrawn numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total_in FROM general_ledger WHERE category = 'supporter_rent_fund';
  SELECT COALESCE(SUM(amount), 0) INTO total_out FROM general_ledger WHERE category = 'pool_rent_deployment';
  SELECT COALESCE(SUM(amount), 0) INTO total_withdrawn FROM general_ledger WHERE category = 'supporter_capital_return';
  RETURN json_build_object(
    'poolBalance', total_in - total_out,
    'totalDeployed', total_out,
    'monthlyObligation', ROUND((total_in - total_withdrawn) * 0.15),
    'deployableAmount', GREATEST(0, (total_in - total_out) - ROUND((total_in - total_withdrawn) * 0.15))
  );
END;
$f$;

-- Byte-for-byte copy of the 3-argument partner_support_houses body under a callable name.
DO $c$
DECLARE v text := pg_get_functiondef('public.partner_support_houses(uuid[],integer,text)'::regprocedure);
BEGIN
  EXECUTE replace(v, 'FUNCTION public.partner_support_houses(', 'FUNCTION public.t_psh3(');
END $c$;
SELECT public.t_as(NULL) IS NULL AS x \gset
-- Round 4: where a note's notices went. One line per partner_name: every pledge notice (P phone email rate), then every
-- booking notice (B kind phone email rate); '-' for a missing value. Ordered by amount / rent, then time.
CREATE OR REPLACE FUNCTION public.t_notices(p_name text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE((SELECT string_agg('P ' || COALESCE(p.phone, '-') || ' ' || COALESCE(p.email, '-') || ' ' || COALESCE(trim_scale(p.return_rate)::text, '-'),
                                     '; ' ORDER BY p.amount, p.created_at)
                     FROM public.promissory_note_pledge_notices p WHERE p.partner_name = p_name), 'P none')
      || ' | '
      || COALESCE((SELECT string_agg('B ' || b.kind || ' ' || COALESCE(b.phone, '-') || ' ' || COALESCE(b.email, '-') || ' '
                                     || COALESCE(trim_scale(b.return_rate)::text, '-'), '; ' ORDER BY b.total_rent, b.created_at, b.kind)
                     FROM public.promissory_house_booking_notices b WHERE b.partner_name = p_name), 'B none') $$;
-- The stored note behind an RPC response: '<has partner_user_id key in the response>|<stored partner_user_id = p_person>'.
CREATE OR REPLACE FUNCTION public.t_note_link(p_res jsonb, p_person text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT (p_res -> 'note' ? 'partner_user_id')::text || '|'
      || COALESCE((SELECT (n.partner_user_id IS NOT DISTINCT FROM public.pid(p_person))::text FROM public.promissory_notes n
                    WHERE n.id = (p_res -> 'note' ->> 'id')::uuid), 'no note') $$;
-- Round 5: this session's sub-transaction cache right now (PG 16+): '<count>/<overflowed>'. The count stops at 64 (the
-- per-backend cache); past that, overflowed = true and every other session's snapshot must look sub-transactions up in
-- pg_subtrans while this transaction is open.
CREATE OR REPLACE FUNCTION public.t_my_subxact() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE v text;
BEGIN
  PERFORM pg_stat_clear_snapshot();
  SELECT s.subxact_count || '/' || s.subxact_overflowed INTO v
    FROM pg_stat_get_backend_idset() b, LATERAL pg_stat_get_backend_subxact(b) s
   WHERE pg_stat_get_backend_pid(b) = pg_backend_pid();
  RETURN v;
END $$;
-- Round 5: earlier bodies of the Phase 1 gate's UPDATE-path retry, rebuilt from the shipped text (cost and sub-transaction
-- comparisons only). Returns a CREATE OR REPLACE statement: EXECUTE it inside a transaction that is rolled back, or put the
-- shipped text back afterwards.
--   'r4' = round 4: the lock + supersede + insert inside BEGIN ... EXCEPTION WHEN unique_violation (one sub-transaction per
--          change), retried once on portfolio_rate_approvals_one_pending, re-raised otherwise;
--   'r3' = round 3: no lock, no retry (plain supersede + insert; a concurrent pending request fails the change with 23505).
-- Only the loop around the shipped statements is rewritten; the statements themselves are the shipped text.
CREATE OR REPLACE FUNCTION public.t_gate_body(p_version text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  d text := pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure);
  -- (also accepts 'IF FOUND THEN ... EXIT; END IF;' in place of 'EXIT WHEN FOUND;', the optional round-5 follow-up fix)
  tail_re text := '\s+ON CONFLICT \(portfolio_id\) WHERE status = ''pending'' DO NOTHING;\s+(EXIT WHEN FOUND;|IF FOUND THEN.*?EXIT;\s+END IF;)\s+IF v_try = 2 THEN.*?END IF;\s+END LOOP;';
  n text;
BEGIN
  IF p_version = 'r4' THEN
    n := regexp_replace(d, 'FOR v_try IN 1\.\.2 LOOP\n', E'FOR v_try IN 1..2 LOOP\n      BEGIN\n');
    n := regexp_replace(n, tail_re, E';\n      EXIT;\n      EXCEPTION WHEN unique_violation THEN\n'
                                   || E'        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;\n'
                                   || E'        IF v_try = 2 OR v_constraint IS DISTINCT FROM ''portfolio_rate_approvals_one_pending'' THEN\n'
                                   || E'          RAISE;\n        END IF;\n      END;\n    END LOOP;');
    n := regexp_replace(n, '(\n  v_ctx +text := [^\n]*\n)', '\1  v_constraint text;' || E'\n');
    IF position('EXCEPTION WHEN unique_violation THEN' in n) = 0 OR position('v_constraint text;' in n) = 0
       OR position('ON CONFLICT' in n) > 0 OR position('      BEGIN' in n) = 0 THEN
      RAISE EXCEPTION 't_gate_body: round-4 body not built';
    END IF;
  ELSIF p_version = 'r3' THEN
    n := regexp_replace(d, 'FOR v_try IN 1\.\.2 LOOP\s+PERFORM 1 FROM public\.portfolio_rate_approvals a.*?ORDER BY a\.id FOR UPDATE;\s+', '');
    n := regexp_replace(n, tail_re, ';');
    IF position('v_try' in n) > 0 OR position('FOR UPDATE;' in n) > 0 OR position('ON CONFLICT' in n) > 0 THEN
      RAISE EXCEPTION 't_gate_body: round-3 body not built';
    END IF;
  ELSE
    RAISE EXCEPTION 't_gate_body: unknown version %', p_version;
  END IF;
  IF position('Superseded: replaced by a newer rate request' in n) = 0 OR position('''rate_change'', auth.uid())' in n) = 0 THEN
    RAISE EXCEPTION 't_gate_body: % body lost the shipped statements', p_version;
  END IF;
  RETURN n;
END $f$;
