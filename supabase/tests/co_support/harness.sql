-- Co-support Phase 1: test-master suite 2. Independent scenarios: each one makes
-- its own people and plans, runs in its own sub-transaction, and records
-- pass/fail, so one failure never hides the others. Run on a freshly reset DB.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE TABLE tt_result (id text PRIMARY KEY, title text, ok boolean, detail text);
CREATE SEQUENCE tt_seq;

CREATE FUNCTION tt_person(p_rate numeric DEFAULT 15, p_float numeric DEFAULT 0, p_signed boolean DEFAULT true,
                          p_partner boolean DEFAULT true, p_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO profiles (id, full_name) VALUES (v, COALESCE(p_name, 'Person' || nextval('tt_seq') || ' Test'));
  IF p_partner THEN INSERT INTO t_partners (user_id, signed, rate) VALUES (v, p_signed, p_rate); END IF;
  IF p_float > 0 THEN
    INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
    VALUES (p_float, 'cash_in', 'float_deposit', v, 'test', 'wallet', 'float');
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION tt_credit(p uuid, amt numeric) RETURNS void LANGUAGE sql AS $$
  INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
  VALUES (amt, 'cash_in', 'float_deposit', p, 'test', 'wallet', 'float') $$;
CREATE FUNCTION tt_plan(p_rent numeric) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; l uuid; tn uuid := tt_person(15, 0, true, false, 'Tenant' || nextval('tt_seq') || ' X');
        ag uuid := tt_person(15, 0, true, false, 'Agent X');
BEGIN
  INSERT INTO landlords (name, phone) VALUES ('Landlord', '0700000001') RETURNING id INTO l;
  INSERT INTO rent_requests (tenant_id, agent_id, landlord_id, rent_amount, request_city, house_image_urls)
  VALUES (tn, ag, l, p_rent, 'Kampala', ARRAY['https://x/h.jpg']) RETURNING id INTO v;
  RETURN v;
END $$;
CREATE FUNCTION tt_as(p uuid) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('request.jwt.claim.sub', COALESCE(p::text, ''), false) $$;
CREATE FUNCTION tt_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'NO ERROR'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION tt_bal(p uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT get_user_float_available_balance(p) $$;
CREATE FUNCTION tt_plan_money(p_rr uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = p_rr) || ' lines, '
      || (SELECT count(*) FROM agent_landlord_float_allocations WHERE rent_request_id = p_rr) || ' allocations, '
      || (SELECT count(*) FROM investor_portfolios ip JOIN funder_pending_portfolios f ON f.portfolio_id = ip.id
            JOIN partner_self_funding_lines l ON l.commitment_id = f.commitment_id WHERE l.rent_request_id = p_rr) || ' portfolios' $$;

-- Runs one scenario body; records pass/fail. Any error (incl. failed ASSERT) = fail, changes undone.
CREATE PROCEDURE tt_run(p_id text, p_title text, p_body text) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF p_body ~* '^\s*declare' THEN
      EXECUTE 'DO $body$ ' || p_body || ' $body$';
    ELSE
      EXECUTE 'DO $body$ BEGIN ' || p_body || ' END $body$';
    END IF;
    INSERT INTO tt_result VALUES (p_id, p_title, true, NULL);
  EXCEPTION WHEN OTHERS OR assert_failure THEN
    INSERT INTO tt_result VALUES (p_id, p_title, false, SQLERRM);
  END;
  PERFORM tt_as(NULL);
END $$;

