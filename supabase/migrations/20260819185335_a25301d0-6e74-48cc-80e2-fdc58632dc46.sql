-- Virtual smoke harness for the Partner Ops proxy-attachment gate.
-- Uses a throwaway schema with synthetic rows only; NO production table is touched.
CREATE SCHEMA IF NOT EXISTS smoke_pops;

CREATE TABLE smoke_pops.rent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL,
  proxy_agent_id uuid
);

CREATE TABLE smoke_pops.results (
  case_name text PRIMARY KEY,
  expected text NOT NULL,
  actual text NOT NULL,
  passed boolean NOT NULL
);

CREATE TRIGGER trg_enforce_partner_ops_proxy_attachment
BEFORE INSERT OR UPDATE ON smoke_pops.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_partner_ops_proxy_attachment();

DO $smoke$
DECLARE
  v_verified uuid;
  v_fake uuid := gen_random_uuid();
  v_id uuid;
  v_err text;
BEGIN
  SELECT agent_user_id INTO v_verified
    FROM public.proxy_agent_identity WHERE status = 'approved' LIMIT 1;

  BEGIN
    INSERT INTO smoke_pops.rent_requests(status, proxy_agent_id)
    VALUES ('partner_ops_approved', NULL);
    v_err := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('insert_forward_without_proxy', 'blocked 42501', v_err, v_err = 'blocked 42501');

  BEGIN
    INSERT INTO smoke_pops.rent_requests(status, proxy_agent_id)
    VALUES ('partner_ops_approved', v_fake);
    v_err := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('insert_forward_with_unverified_proxy', 'blocked 42501', v_err, v_err = 'blocked 42501');

  BEGIN
    INSERT INTO smoke_pops.rent_requests(status, proxy_agent_id)
    VALUES ('partner_ops_approved', v_verified);
    v_err := 'allowed';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('insert_forward_with_verified_proxy', 'allowed', v_err, v_err = 'allowed');

  BEGIN
    INSERT INTO smoke_pops.rent_requests(status, proxy_agent_id)
    VALUES ('landlord_ops_approved', NULL) RETURNING id INTO v_id;
    v_err := 'allowed';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('queue_row_without_proxy', 'allowed', v_err, v_err = 'allowed');

  BEGIN
    UPDATE smoke_pops.rent_requests SET status = 'partner_ops_approved' WHERE id = v_id;
    v_err := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('transition_without_proxy', 'blocked 42501', v_err, v_err = 'blocked 42501');

  BEGIN
    UPDATE smoke_pops.rent_requests
       SET status = 'partner_ops_approved', proxy_agent_id = v_verified
     WHERE id = v_id;
    v_err := 'allowed';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'blocked 42501';
  END;
  INSERT INTO smoke_pops.results VALUES
    ('transition_with_verified_proxy', 'allowed', v_err, v_err = 'allowed');

  INSERT INTO smoke_pops.results VALUES
    ('is_approved_proxy_agent_fake_uuid', 'false',
     public.is_approved_proxy_agent(v_fake)::text,
     public.is_approved_proxy_agent(v_fake) = false);

  INSERT INTO smoke_pops.results VALUES
    ('is_approved_proxy_agent_verified', 'true',
     public.is_approved_proxy_agent(v_verified)::text,
     public.is_approved_proxy_agent(v_verified) = true);
END
$smoke$;