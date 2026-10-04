\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  _agent uuid;
  _tenant uuid;
  _landlord uuid;
  _req uuid;
  _row public.rent_requests%ROWTYPE;
BEGIN
  SELECT agent_id, tenant_id, landlord_id INTO _agent, _tenant, _landlord
    FROM public.rent_requests
   WHERE agent_id IS NOT NULL AND tenant_id IS NOT NULL AND landlord_id IS NOT NULL
   LIMIT 1;
  IF _agent IS NULL THEN
    RAISE EXCEPTION 'No seed rent_requests row available for FK reuse';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', _agent::text)::text, true);

  INSERT INTO public.rent_requests (
    tenant_id, landlord_id, agent_id, rent_amount, duration_days,
    access_fee, request_fee, total_repayment, daily_repayment,
    amount_repaid, tenant_no_smartphone, registration_type, tenancy_status,
    status, rejected_at, rejected_reason, rejected_at_stage, reopen_count
  ) VALUES (
    _tenant, _landlord, _agent, 100000, 30,
    33000, 10000, 143000, 4767,
    0, false, 'agent_registered', 'active',
    'rejected', now(), 'test rejection', 'pending', 0
  ) RETURNING id INTO _req;

  PERFORM public.agent_resubmit_rent_request(
    _req,
    jsonb_build_object('rent_amount', 200000, 'duration_days', 60),
    'fixing the rejected items per reviewer note'
  );

  SELECT * INTO _row FROM public.rent_requests WHERE id = _req;

  -- Canonical Welile formula (reference table): 200000 / 60d
  ASSERT _row.status = 'pending', format('status expected pending, got %s', _row.status);
  ASSERT _row.rent_amount = 200000, format('rent_amount expected 200000, got %s', _row.rent_amount);
  ASSERT _row.duration_days = 60, format('duration_days expected 60, got %s', _row.duration_days);
  ASSERT _row.access_fee = 153780, format('access_fee expected 153780, got %s', _row.access_fee);
  ASSERT _row.request_fee = 10000, format('request_fee expected 10000, got %s', _row.request_fee);
  ASSERT _row.total_repayment = 363780, format('total_repayment expected 363780, got %s', _row.total_repayment);
  ASSERT _row.daily_repayment = 6063, format('daily_repayment expected 6063, got %s', _row.daily_repayment);
  ASSERT _row.reopen_count = 1, format('reopen_count expected 1, got %s', _row.reopen_count);
  ASSERT _row.rejected_at IS NULL, 'rejected_at should be cleared';
  ASSERT _row.rejected_reason IS NULL, 'rejected_reason should be cleared';
  ASSERT _row.rejected_at_stage IS NULL, 'rejected_at_stage should be cleared';
  ASSERT _row.resubmitted_at IS NOT NULL, 'resubmitted_at should be set';
  ASSERT _row.resubmitted_note = 'fixing the rejected items per reviewer note', 'note mismatch';

  RAISE NOTICE 'PASS: resubmit RPC updated all fields correctly';
END $$;
ROLLBACK;
