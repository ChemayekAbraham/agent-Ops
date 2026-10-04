TRUNCATE public._sc_smoke_results;

CREATE OR REPLACE FUNCTION public.sc_smoke() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE
  log text[] := '{}';
  parent uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  ten uuid := gen_random_uuid(); ops uuid := gen_random_uuid();
  ll uuid; rr uuid; tid uuid; msg text;
BEGIN
  BEGIN
    INSERT INTO auth.users(id,email,instance_id,aud,role,raw_user_meta_data)
    VALUES (parent,'p@sc.local','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"full_name":"SC Parent"}'),
           (a,'a@sc.local','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"full_name":"SC Sub A"}'),
           (b,'b@sc.local','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"full_name":"SC Sub B"}'),
           (ten,'t@sc.local','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"full_name":"SC Tenant"}'),
           (ops,'o@sc.local','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"full_name":"SC Ops"}');
    UPDATE profiles SET full_name='SC Parent' WHERE id=parent;
    INSERT INTO agent_subagents(parent_agent_id,sub_agent_id,status,source)
      VALUES (parent,a,'verified','test'),(parent,a,'verified','dupe'),(parent,b,'verified','test');
    INSERT INTO user_roles(user_id,role) VALUES (ops,'agent_ops') ON CONFLICT DO NOTHING;
    INSERT INTO landlords(name,phone,registered_by) VALUES ('SC Smoke LL','0700000111',a) RETURNING id INTO ll;
    INSERT INTO rent_requests(tenant_id,landlord_id,agent_id,assigned_agent_id,rent_amount,status)
      VALUES (ten,ll,parent,a,200000,'funded') RETURNING id INTO rr;

    PERFORM set_config('request.jwt.claim.sub', parent::text, true);

    BEGIN
      PERFORM agent_request_subagent_tenant_transfer(rr,b,'moving tenant for coverage reasons');
      log := log || '1 assigned-only plan transferable=PASS';
    EXCEPTION WHEN others THEN log := log || ('1 assigned-only plan transferable=FAIL '||SQLERRM); END;
    SELECT id INTO tid FROM subagent_tenant_transfers WHERE rent_request_id=rr AND status='pending';

    BEGIN
      PERFORM agent_request_subagent_tenant_transfer(rr,b,'second attempt should be blocked');
      log := log || '2 duplicate pending blocked=FAIL allowed';
    EXCEPTION WHEN others THEN log := log || ('2 duplicate pending blocked=PASS '||SQLERRM); END;

    BEGIN
      PERFORM agent_unlink_subagent(a,'removing this sub agent from team');
      log := log || '3 unlink blocked on assigned active plan=FAIL allowed';
    EXCEPTION WHEN others THEN log := log || ('3 unlink blocked on assigned active plan=PASS '||SQLERRM); END;

    INSERT INTO agent_listing_blocks(agent_id,blocked_until,reason,auto_blocked,active,freeze_scope)
      VALUES (b, now()+interval '30 days','company fraud freeze',true,true,'all');
    PERFORM agent_suspend_subagent(b,7,'parent level suspension for testing');
    SELECT count(*)::text INTO msg FROM agent_listing_blocks WHERE agent_id=b AND active AND auto_blocked;
    log := log || ('4 company auto freeze survives parent suspend='||CASE WHEN msg='1' THEN 'PASS' ELSE 'FAIL auto='||msg END);

    BEGIN
      PERFORM agent_request_subagent_tenant_transfer(rr,b,'attempt to a suspended sub agent');
      log := log || '5 suspended recipient blocked=FAIL allowed';
    EXCEPTION WHEN others THEN log := log || ('5 suspended recipient blocked=PASS '||SQLERRM); END;

    PERFORM agent_restore_subagent(b,'lifting parent suspension now ok');
    SELECT count(*)::text INTO msg FROM agent_listing_blocks WHERE agent_id=b AND active;
    log := log || ('6 restore lifts parent block only='||CASE WHEN msg='1' THEN 'PASS company freeze intact' ELSE 'FAIL active='||msg END);

    BEGIN
      PERFORM agent_restore_subagent(b,'nothing left to lift here now');
      log := log || '7 restore with no parent block errors=FAIL silent success';
    EXCEPTION WHEN others THEN log := log || ('7 restore with no parent block errors=PASS '||SQLERRM); END;

    PERFORM set_config('request.jwt.claim.sub', ops::text, true);
    BEGIN
      PERFORM ops_decide_subagent_tenant_transfer(tid,true,'approved after field verification');
      SELECT (agent_id=b AND assigned_agent_id=b)::text INTO msg FROM rent_requests WHERE id=rr;
      log := log || ('8 ops approve reassigns plan='||CASE WHEN msg='true' THEN 'PASS' ELSE 'FAIL '||msg END);
    EXCEPTION WHEN others THEN log := log || ('8 ops approve reassigns plan=FAIL '||SQLERRM); END;

    PERFORM set_config('request.jwt.claim.sub', parent::text, true);
    UPDATE rent_requests SET status='funded', agent_id=a, assigned_agent_id=a WHERE id=rr;
    PERFORM agent_request_subagent_tenant_transfer(rr,b,'second legitimate move request');
    SELECT id INTO tid FROM subagent_tenant_transfers WHERE rent_request_id=rr AND status='pending';
    UPDATE rent_requests SET status='completed' WHERE id=rr;
    PERFORM set_config('request.jwt.claim.sub', ops::text, true);
    BEGIN
      PERFORM ops_decide_subagent_tenant_transfer(tid,true,'approving a now inactive plan');
      log := log || '9 approve on inactive plan refused=FAIL allowed';
    EXCEPTION WHEN others THEN log := log || ('9 approve on inactive plan refused=PASS '||SQLERRM); END;

    PERFORM set_config('request.jwt.claim.sub', parent::text, true);
    PERFORM agent_suspend_subagent(a,5,'suspending before unlink test');
    PERFORM agent_unlink_subagent(a,'sub agent leaving the team now');
    SELECT count(*)::text INTO msg FROM agent_subagents WHERE parent_agent_id=parent AND sub_agent_id=a;
    log := log || ('10a all duplicate links removed='||CASE WHEN msg='0' THEN 'PASS' ELSE 'FAIL remaining='||msg END);
    SELECT count(*)::text INTO msg FROM agent_subagent_link_archive WHERE parent_agent_id=parent AND sub_agent_id=a;
    log := log || ('10b both links archived='||CASE WHEN msg='2' THEN 'PASS' ELSE 'FAIL archived='||msg END);
    SELECT count(*)::text INTO msg FROM subagent_tenant_transfers WHERE parent_agent_id=parent AND status='pending';
    log := log || ('10c pending transfers auto-cancelled='||CASE WHEN msg='0' THEN 'PASS' ELSE 'FAIL pending='||msg END);
    SELECT count(*)::text INTO msg FROM agent_listing_blocks WHERE agent_id=a AND active;
    log := log || ('10d ex-parent suspension lifted='||CASE WHEN msg='0' THEN 'PASS' ELSE 'FAIL active='||msg END);

    RAISE EXCEPTION 'SC_SMOKE_SANDBOX_ROLLBACK';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'SC_SMOKE_SANDBOX_ROLLBACK' THEN
      log := log || ('HARNESS ABORTED='||SQLERRM);
    END IF;
  END;

  INSERT INTO public._sc_smoke_results(step,result)
  SELECT split_part(x,'=',1), substr(x, strpos(x,'=')+1) FROM unnest(log) x;
END;
$fn$;

SELECT public.sc_smoke();
DROP FUNCTION public.sc_smoke();