-- Ledger posting boundary (20261013126000) on a DISPOSABLE local database.
-- create_ledger_transaction is a RECORDING STAND-IN here: these tests prove the
-- permission boundary and exactly which legs the boundary builds, not the real
-- ledger's internals (which live in production).
\set ON_ERROR_STOP 0
CREATE SCHEMA IF NOT EXISTS lt;
CREATE OR REPLACE FUNCTION lt.ok(c boolean, id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '% %', CASE WHEN c THEN 'PASS' ELSE 'FAIL' END, id; END $$;
CREATE OR REPLACE FUNCTION lt.raises(sql text, state text, id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RAISE NOTICE 'FAIL % (expected %, statement succeeded)', id, state;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = state THEN RAISE NOTICE 'PASS %', id; ELSE RAISE NOTICE 'FAIL % (expected % got %: %)', id, state, SQLSTATE, SQLERRM; END IF;
END $$;
CREATE OR REPLACE FUNCTION lt.act_as(u uuid, r text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      EXECUTE format('SET LOCAL ROLE %I', r); END $$;
GRANT USAGE ON SCHEMA lt TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lt TO anon, authenticated, service_role;

-- identities: c=coo, p=partner-ops grant, x=revoked grant, e=employee, t=tenant,
-- i=investor (partner), m=managed partner, a=proxy agent
CREATE TABLE lt.ids (k text PRIMARY KEY, id uuid);
INSERT INTO lt.ids VALUES ('c','10000000-0000-4000-8000-00000000000c'),('p','10000000-0000-4000-8000-00000000000d'),
  ('x','10000000-0000-4000-8000-00000000000e'),('e','10000000-0000-4000-8000-0000000000e1'),
  ('t','10000000-0000-4000-8000-0000000000f1'),('i','10000000-0000-4000-8000-0000000000a1'),
  ('m','10000000-0000-4000-8000-0000000000a2'),('a','10000000-0000-4000-8000-0000000000b1');
GRANT SELECT ON lt.ids TO anon, authenticated, service_role;
CREATE FUNCTION lt.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM lt.ids WHERE ids.k = $1 $$;
GRANT EXECUTE ON FUNCTION lt.id(text) TO anon, authenticated, service_role;
INSERT INTO auth.users (id, email) SELECT id, k||'@example.invalid' FROM lt.ids;
INSERT INTO public.profiles (id, full_name, email) SELECT id, 'T '||k, k||'@example.invalid' FROM lt.ids;
INSERT INTO public.user_roles (user_id, role) VALUES
  (lt.id('c'),'coo'), (lt.id('p'),'employee'), (lt.id('x'),'employee'), (lt.id('e'),'employee'),
  (lt.id('t'),'tenant'), (lt.id('i'),'supporter'), (lt.id('m'),'supporter'), (lt.id('a'),'agent');
INSERT INTO public.staff_permissions (user_id, permitted_dashboard, revoked_at) VALUES
  (lt.id('p'),'partner-ops',NULL), (lt.id('x'),'partner-ops', now());
INSERT INTO public.investor_portfolios (id, investor_id, investment_amount, roi_percentage) VALUES
  ('20000000-0000-4000-8000-000000000001', lt.id('i'), 1000000, 15),   -- one cycle = 150,000
  ('20000000-0000-4000-8000-000000000002', lt.id('m'), 2000000, 10);   -- one cycle = 200,000
INSERT INTO public.proxy_agent_assignments (beneficiary_id, agent_id, is_active, approval_status, is_managed_account) VALUES
  (lt.id('m'), lt.id('a'), true, 'approved', true),
  (lt.id('i'), lt.id('a'), true, 'approved', false);                   -- a proxy, but NOT managed

-- ── the boundary: authorisation ──
BEGIN; SELECT lt.act_as(lt.id('e'));
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ','o','i')$$,'42501','A-07 an ordinary employee cannot post partner Returns'); ROLLBACK;
BEGIN; SELECT lt.act_as(lt.id('t'));
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ','o','i')$$,'42501','A-08 a tenant cannot post partner Returns'); ROLLBACK;
BEGIN; SELECT lt.act_as(lt.id('x'));
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ','o','i')$$,'42501','A-09 a revoked partner-ops grant no longer authorises'); ROLLBACK;
BEGIN; SET LOCAL ROLE anon;
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ','o','i')$$,'42501','A-10 anonymous cannot call the boundary'); ROLLBACK;

-- ── the boundary: legitimate COO / Partners Ops postings ──
BEGIN; SELECT lt.act_as(lt.id('c'));
SELECT lt.ok(public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',150000,'CMP-ABCD1234-WXYZ','out text','in text') IS NOT NULL,
             'A-11 a COO compounds Returns through the boundary');
RESET ROLE;
SELECT lt.ok((SELECT count(*) = 2
                 AND bool_and(e->>'ledger_scope' = 'platform') AND bool_and((e->>'user_id')::uuid = lt.id('i'))
                 AND bool_and((e->>'amount')::numeric = 150000) AND bool_and((e->>'linked_party')::uuid = lt.id('c'))
                 AND count(*) FILTER (WHERE e->>'direction'='cash_out' AND e->>'category'='roi_expense') = 1
                 AND count(*) FILTER (WHERE e->>'direction'='cash_in'  AND e->>'category'='roi_reinvestment') = 1
                FROM public.ledger_capture lc, jsonb_array_elements(lc.entries) e),
             'A-12 compound = exactly the two platform legs the page used to send');
SELECT lt.ok((SELECT bool_and(NOT skip_balance_check) AND bool_and(idempotency_key = 'portfolio-roi-ledger:CMP-ABCD1234-WXYZ') FROM public.ledger_capture),
             'A-13 the boundary never skips the balance check and posts idempotently');
ROLLBACK;

BEGIN; SELECT lt.act_as(lt.id('p'));
SELECT lt.ok(public.post_portfolio_roi_ledger('split_keep_returns','20000000-0000-4000-8000-000000000001',50000,'SPL-ABCD1234-WXYZ','o','i') IS NOT NULL,
             'A-14 a partner-ops staff member can post a split');
RESET ROLE;
SELECT lt.ok((SELECT (e->>'user_id')::uuid = lt.id('i') AND e->>'ledger_scope'='wallet' AND e->>'category'='roi_wallet_credit'
                     AND e->>'recipient_type'='user' AND e->>'wallet_bucket'='withdrawable' AND (e->>'linked_party')::uuid = lt.id('i')
                FROM public.ledger_capture lc, jsonb_array_elements(lc.entries) e WHERE e->>'direction'='cash_in'),
             'A-15 keep-as-Returns credits the partner''s own withdrawable wallet (non-managed proxy ignored)');
ROLLBACK;

BEGIN; SELECT lt.act_as(lt.id('c'));
SELECT public.post_portfolio_roi_ledger('split_keep_returns','20000000-0000-4000-8000-000000000002',60000,'SPL-MNGD1234-WXYZ','o','i');
RESET ROLE;
SELECT lt.ok((SELECT (e->>'user_id')::uuid = lt.id('a') AND (e->>'linked_party')::uuid = lt.id('m')
                FROM public.ledger_capture lc, jsonb_array_elements(lc.entries) e WHERE e->>'direction'='cash_in'),
             'A-16 keep-as-Returns for a managed partner credits the proxy agent, attributed to the partner');
ROLLBACK;

BEGIN; SELECT lt.act_as(lt.id('c'));
SELECT public.post_portfolio_roi_ledger('split_reinvest','20000000-0000-4000-8000-000000000002',60000,'SPL-RNVS1234-WXYZ','o','i');
RESET ROLE;
SELECT lt.ok((SELECT bool_and(e->>'ledger_scope'='platform') AND bool_and((e->>'user_id')::uuid = lt.id('m'))
                FROM public.ledger_capture lc, jsonb_array_elements(lc.entries) e),
             'A-17 split reinvest stays platform scope on the partner (no wallet movement, even if managed)');
ROLLBACK;

-- duplicate / retry
BEGIN; SELECT lt.act_as(lt.id('c'));
CREATE TEMP TABLE g AS SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-DUPL1234-WXYZ','o','i') AS a;
GRANT ALL ON g TO authenticated;
SELECT lt.ok(public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-DUPL1234-WXYZ','o','i') = (SELECT a FROM g),
             'A-18 a repeated reference returns the same transaction');
RESET ROLE;
SELECT lt.ok((SELECT count(*) FROM public.ledger_capture) = 1, 'A-19 ...and posts only once');
ROLLBACK;

-- manipulated payloads
BEGIN; SELECT lt.act_as(lt.id('c'));
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('mint','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ','o','i')$$,'22023','A-20 an unknown operation is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'ADMIN-1','o','i')$$,'22023','A-21 a reference outside CMP-/SPL- is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',0,'CMP-ABCD1234-WXYZ','o','i')$$,'22023','A-22 a zero amount is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',-5,'CMP-ABCD1234-WXYZ','o','i')$$,'22023','A-23 a negative amount is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',10.5,'CMP-ABCD1234-WXYZ','o','i')$$,'22023','A-24 a fractional amount is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',150001,'CMP-ABCD1234-WXYZ','o','i')$$,'22023','A-25 more than one cycle of Returns is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound',gen_random_uuid(),1000,'CMP-ABCD1234-WXYZ','o','i')$$,'P0002','A-26 an unknown portfolio is refused');
SELECT lt.raises($$SELECT public.post_portfolio_roi_ledger('compound','20000000-0000-4000-8000-000000000001',1000,'CMP-ABCD1234-WXYZ',repeat('x',2001),'i')$$,'22023','A-27 an over-long description is refused');
ROLLBACK;
SELECT lt.ok((SELECT pronargs = 6 AND NOT (proargnames @> ARRAY['p_user_id']) AND NOT (proargnames @> ARRAY['entries'])
                FROM pg_proc WHERE proname = 'post_portfolio_roi_ledger'),
             'A-28 the boundary accepts no recipient, wallet or entries parameter');

-- ── the direct path is closed ──
BEGIN; SELECT lt.act_as(lt.id('e'));
SELECT lt.raises($$SELECT public.create_ledger_transaction('[]'::jsonb, NULL, true)$$,'42501','A-01 a signed-in user cannot call create_ledger_transaction (or pass skip_balance_check)');
SELECT lt.raises($$SELECT public.create_ledger_transaction('[]'::jsonb, NULL, false, 'legacy')$$,'42501','A-02 ...nor the legacy overload');
SELECT lt.raises($$SELECT public.create_ledger_transaction_accrual_only('[]'::jsonb)$$,'42501','A-03 ...nor create_ledger_transaction_accrual_only');
ROLLBACK;
BEGIN; SELECT lt.act_as(lt.id('c'));
SELECT lt.raises($$SELECT public.create_ledger_transaction('[]'::jsonb)$$,'42501','A-04 not even an authorised COO, directly');
ROLLBACK;
BEGIN; SET LOCAL ROLE anon;
SELECT lt.raises($$SELECT public.create_ledger_transaction('[]'::jsonb)$$,'42501','A-05 anonymous cannot call it');
ROLLBACK;
BEGIN; SET LOCAL ROLE service_role;
SELECT lt.ok(public.create_ledger_transaction('[{"user_id":null,"direction":"cash_in","amount":1},{"user_id":null,"direction":"cash_out","amount":1}]'::jsonb, 'svc-1') IS NOT NULL,
             'A-06 the service role (edge functions) still can');
ROLLBACK;
BEGIN; SELECT lt.act_as(lt.id('e'));
SELECT lt.ok(public.existing_definer_poster() IS NOT NULL, 'A-29 an existing owner-run SQL function that posts still works for a signed-in caller');
ROLLBACK;
SELECT lt.ok((SELECT bool_and(proconfig::text LIKE '%pg_temp%') FROM pg_proc
               WHERE proname IN ('post_portfolio_roi_ledger','_ledger_can_post_partner_returns')),
             'A-30 new definer functions pin search_path with pg_temp last');
SELECT lt.ok(NOT has_function_privilege('authenticated','public._ledger_can_post_partner_returns(uuid)','EXECUTE'),
             'A-31 the authorisation helper is not callable by signed-in users');
