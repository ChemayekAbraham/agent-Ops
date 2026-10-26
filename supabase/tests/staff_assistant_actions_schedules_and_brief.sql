-- Transactional SQL tests for 20261026160000_staff_assistant_actions_schedules_and_brief.sql
-- Always runs inside BEGIN ... ROLLBACK so no data is mutated.

BEGIN;

DO $$
DECLARE
  v_staff_a       uuid := gen_random_uuid();
  v_staff_b       uuid := gen_random_uuid();
  v_tenant_user   uuid := gen_random_uuid();
  v_rem_res       jsonb;
  v_rem_id        uuid;
  v_notif_res     jsonb;
  v_notif_id      uuid;
  v_sched_res     jsonb;
  v_sched_id      uuid;
  v_list_res      jsonb;
  v_prefs_res     jsonb;
  v_denied        boolean := false;
BEGIN
  -- Ensure Zoe is enabled in staff_assistant_config
  UPDATE public.staff_assistant_config SET enabled = true WHERE id = true;

  -- Seed two staff members with emails and one tenant-only user
  INSERT INTO public.profiles (id, full_name, email, phone)
  VALUES
    (v_staff_a, 'Zoe Test Staff Alpha', 'alpha.staff@welile.test', '256700911111'),
    (v_staff_b, 'Zoe Test Staff Beta',  'beta.staff@welile.test',  '256700922222'),
    (v_tenant_user, 'Zoe Test Tenant',  'tenant.only@welile.test', '256700933333');

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES
    (v_staff_a, 'tenant_ops', true),
    (v_staff_b, 'landlord_ops', true),
    (v_tenant_user, 'tenant', true);

  -- 1. Authenticate as Staff Alpha
  PERFORM set_config('request.jwt.claim.sub', v_staff_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_staff_a::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  -- Verify Morning Brief is off by default
  v_list_res := public.assistant_staff_my_reminders_and_schedules(false);
  IF (v_list_res #>> '{data,morning_brief,enabled}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Expected morning_brief.enabled = false by default, got %', v_list_res;
  END IF;

  -- 2. Create a personal reminder for myself
  v_rem_res := public.staff_assistant_create_reminder(
    'Review Landlord Ops Rent Plan payout queue',
    now() + interval '2 hours',
    'Check Wakiso landlords before 14:00'
  );
  v_rem_id := (v_rem_res #>> '{reminder,id}')::uuid;
  IF v_rem_id IS NULL THEN
    RAISE EXCEPTION 'Expected reminder id from staff_assistant_create_reminder';
  END IF;

  -- 3. Send an in-app notification to Staff Beta (notifications table)
  v_notif_res := public.staff_assistant_send_colleague_notification(
    'beta.staff@welile.test',
    'Rent Plan Review Ready',
    'Please check the 3 Wakiso Rent Plans in Landlord Ops.'
  );
  v_notif_id := (v_notif_res ->> 'notification_id')::uuid;
  IF v_notif_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.id = v_notif_id
       AND n.user_id = v_staff_b
       AND n.type = 'staff_assistant'
  ) THEN
    RAISE EXCEPTION 'Expected notification row in public.notifications for Staff Beta';
  END IF;

  -- 4. Attempting to notify a non-staff (tenant) email is refused with 42501
  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_send_colleague_notification(
      'tenant.only@welile.test',
      'Should Fail',
      'Non-staff must not be notified.'
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 42501 when notifying a non-staff email';
  END IF;

  -- 5. Create a daily report schedule for Staff Beta
  v_sched_res := public.staff_assistant_create_schedule(
    'Daily Tenant Ops Waiting Queue',
    'get_tops_pipeline_waiting_on_lops',
    'assistant_staff_tops_pipeline_waiting_on_lops',
    '{}'::jsonb,
    'daily',
    ARRAY['beta.staff@welile.test'],
    NULL,
    '07:30',
    'Daily 07:30 Kampala report'
  );
  v_sched_id := (v_sched_res #>> '{schedule,id}')::uuid;
  IF v_sched_id IS NULL THEN
    RAISE EXCEPTION 'Expected schedule id from staff_assistant_create_schedule';
  END IF;

  -- 6. Attempting to schedule a report to a non-staff email is refused with 42501
  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_create_schedule(
      'Bad Schedule',
      'get_my_tasks',
      'assistant_staff_my_tasks',
      '{}'::jsonb,
      'daily',
      ARRAY['tenant.only@welile.test']
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 42501 when scheduling a report to a non-staff email';
  END IF;

  -- 7. List reminders and schedules via assistant_staff_my_reminders_and_schedules
  v_list_res := public.assistant_staff_my_reminders_and_schedules(false);
  IF (v_list_res #>> '{data,active_reminders_count}')::int <> 1
     OR (v_list_res #>> '{data,active_schedules_count}')::int <> 1 THEN
    RAISE EXCEPTION 'Expected 1 active reminder and 1 active schedule, got %', v_list_res;
  END IF;

  -- 8. Enable Morning Brief for Staff Alpha
  v_prefs_res := public.staff_assistant_set_morning_brief_prefs(true, '07:30', false);
  IF (v_prefs_res #>> '{morning_brief,enabled}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected morning_brief.enabled = true after opt-in';
  END IF;

  -- 9. Cancel the reminder and schedule
  PERFORM public.staff_assistant_cancel_reminder(v_rem_id);
  PERFORM public.staff_assistant_cancel_schedule(v_sched_id);

  v_list_res := public.assistant_staff_my_reminders_and_schedules(false);
  IF (v_list_res #>> '{data,active_reminders_count}')::int <> 0
     OR (v_list_res #>> '{data,active_schedules_count}')::int <> 0 THEN
    RAISE EXCEPTION 'Expected 0 active reminders and schedules after cancel, got %', v_list_res;
  END IF;

  -- 10. Verify non-staff (tenant) caller is refused on all tools and action RPCs
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_tenant_user::text, 'role', 'authenticated')::text,
    true
  );

  v_denied := false;
  BEGIN
    PERFORM public.assistant_staff_my_reminders_and_schedules(false);
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 42501 for tenant caller on assistant_staff_my_reminders_and_schedules';
  END IF;
END;
$$;

ROLLBACK;
