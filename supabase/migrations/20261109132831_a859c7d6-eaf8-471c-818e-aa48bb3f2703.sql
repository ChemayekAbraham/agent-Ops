-- [SRQ-OFFSYNC-01] Requisition approval office follows HR appointment (COO + CFO)

-- 1. COO access mapping: chief_operations_officer confers the coo role + coo dashboard
INSERT INTO public.hr_position_access (position_id, role, dashboard_key, reason)
SELECT p.id, 'coo'::public.app_role, NULL,
       'COO position confers the coo role for operations reach'
  FROM public.hr_positions p
 WHERE p.key = 'chief_operations_officer'
   AND NOT EXISTS (
     SELECT 1 FROM public.hr_position_access x
      WHERE x.position_id = p.id AND x.role = 'coo'::public.app_role
   );

INSERT INTO public.hr_position_access (position_id, role, dashboard_key, reason)
SELECT p.id, NULL, 'coo',
       'COO position confers the coo dashboard'
  FROM public.hr_positions p
 WHERE p.key = 'chief_operations_officer'
   AND NOT EXISTS (
     SELECT 1 FROM public.hr_position_access x
      WHERE x.position_id = p.id AND x.dashboard_key = 'coo'
   );

-- 2. Internal apply function: the body of staff_requisition_office_transfer
--    after the CEO check, with the actor passed in explicitly.
CREATE OR REPLACE FUNCTION public.staff_requisition_office_apply_transfer(
  p_office text,
  p_new_holder uuid,
  p_reason text,
  p_actor uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old uuid;
  v_name text;
  v_moved integer := 0;
  r record;
BEGIN
  IF p_office IS NULL OR p_office NOT IN ('coo','ceo','cfo') THEN
    RAISE EXCEPTION 'Unknown office: %', p_office;
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.';
  END IF;
  IF p_new_holder IS NULL THEN
    RAISE EXCEPTION 'A new holder is required.';
  END IF;

  SELECT coalesce(full_name, p_new_holder::text) INTO v_name FROM public.profiles WHERE id = p_new_holder;
  v_name := coalesce(v_name, p_new_holder::text);

  IF NOT public.has_role(p_new_holder, p_office::app_role) THEN
    RAISE EXCEPTION '% does not hold the % role. Grant the role first.', v_name, upper(p_office);
  END IF;

  SELECT holder_id INTO v_old FROM public.staff_requisition_offices WHERE office_key = p_office FOR UPDATE;

  IF v_old = p_new_holder OR EXISTS (
    SELECT 1 FROM public.staff_requisition_offices WHERE holder_id = p_new_holder
  ) THEN
    RAISE EXCEPTION 'One person cannot hold two offices.';
  END IF;

  UPDATE public.staff_requisition_offices
     SET holder_id = p_new_holder, holder_since = now(), updated_by = p_actor, updated_at = now()
   WHERE office_key = p_office;

  UPDATE public.staff_requisition_prompts
     SET state = 'resolved', resolved_at = now(), resolution = 'transferred'
   WHERE stage = p_office
     AND approver_id = v_old
     AND state <> 'resolved';

  FOR r IN
    SELECT s.id, s.requester_id, s.supervisor_decided_by, s.coo_decided_by, s.ceo_decided_by
      FROM public.staff_requisitions s
     WHERE coalesce(s.request_kind, 'requisition') = 'requisition'
       AND s.stage = p_office
  LOOP
    IF p_new_holder <> r.requester_id
       AND p_new_holder IS DISTINCT FROM r.supervisor_decided_by
       AND p_new_holder IS DISTINCT FROM r.coo_decided_by
       AND p_new_holder IS DISTINCT FROM r.ceo_decided_by THEN
      INSERT INTO public.staff_requisition_prompts (requisition_id, approver_id, stage)
      VALUES (r.id, p_new_holder, p_office)
      ON CONFLICT (requisition_id, approver_id, stage) DO UPDATE
        SET state = 'open',
            snooze_until = NULL,
            resolved_at = NULL,
            resolution = NULL,
            last_pushed_at = NULL;
      v_moved := v_moved + 1;
    ELSE
      INSERT INTO public.staff_requisition_events (requisition_id, action, actor_name, stage, comment)
      VALUES (
        r.id, 'comment', 'System', p_office,
        'No eligible named approver to prompt at ' || upper(p_office) || ' stage.'
      );
    END IF;
  END LOOP;

  INSERT INTO public.staff_requisition_office_history
    (office_key, from_holder, to_holder, reason, transferred_by, prompts_moved)
  VALUES (p_office, v_old, p_new_holder, trim(p_reason), coalesce(p_actor, p_new_holder), v_moved);

  RETURN v_moved;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.staff_requisition_office_apply_transfer(text, uuid, text, uuid) FROM public, anon, authenticated;

-- 2b. The public transfer keeps its signature, grants, CEO check and error messages.
CREATE OR REPLACE FUNCTION public.staff_requisition_office_transfer(p_office text, p_new_holder uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.staff_requisition_offices WHERE office_key = 'ceo' AND holder_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the CEO office can transfer offices.';
  END IF;

  RETURN public.staff_requisition_office_apply_transfer(p_office, p_new_holder, p_reason, auth.uid());
END
$function$;

-- 3. Who should hold an office according to HR appointments.
CREATE OR REPLACE FUNCTION public.staff_requisition_office_hr_holder(p_office text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pos AS (
    SELECT p.id AS position_id, p.title
      FROM public.hr_positions p
     WHERE p.key = CASE p_office
                     WHEN 'coo' THEN 'chief_operations_officer'
                     WHEN 'cfo' THEN 'chief_finance_officer'
                   END
  ),
  open_assignments AS (
    SELECT s.user_id, a.is_primary
      FROM public.hr_assignments a
      JOIN pos ON pos.position_id = a.position_id
      JOIN public.hr_staff s ON s.id = a.staff_id
     WHERE s.active
       AND a.started_on <= current_date
       AND (a.ended_on IS NULL OR a.ended_on > current_date)
  ),
  primaries AS (
    SELECT user_id FROM open_assignments WHERE is_primary
  )
  SELECT CASE
           WHEN (SELECT count(*) FROM primaries) = 1 THEN (SELECT user_id FROM primaries)
           WHEN (SELECT count(*) FROM open_assignments) = 1 THEN (SELECT user_id FROM open_assignments)
           ELSE NULL
         END
$function$;

GRANT EXECUTE ON FUNCTION public.staff_requisition_office_hr_holder(text) TO authenticated;

-- 4. Reconcile coo/cfo offices with HR appointments.
CREATE OR REPLACE FUNCTION public.staff_requisition_offices_reconcile(p_apply boolean DEFAULT false)
RETURNS TABLE(office text, office_holder text, hr_holder text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_office text;
  v_current uuid;
  v_hr uuid;
  v_title text;
  v_moved integer;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.hr_is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM public.staff_requisition_offices
        WHERE office_key = 'ceo' AND holder_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  FOR v_office IN SELECT o FROM (VALUES ('coo'), ('cfo')) AS v(o) LOOP
    office := v_office;
    SELECT o.holder_id INTO v_current
      FROM public.staff_requisition_offices o WHERE o.office_key = v_office;
    v_hr := public.staff_requisition_office_hr_holder(v_office);
    SELECT coalesce(p.full_name, v_current::text) INTO office_holder
      FROM public.profiles p WHERE p.id = v_current;
    SELECT coalesce(p.full_name, v_hr::text) INTO hr_holder
      FROM public.profiles p WHERE p.id = v_hr;

    IF v_hr IS NULL THEN
      action := 'no_hr_holder';
    ELSIF v_current IS NOT DISTINCT FROM v_hr THEN
      action := 'in_sync';
    ELSIF NOT p_apply THEN
      action := 'would_transfer';
    ELSE
      BEGIN
        SELECT p.title INTO v_title
          FROM public.hr_positions p
         WHERE p.key = CASE v_office
                         WHEN 'coo' THEN 'chief_operations_officer'
                         WHEN 'cfo' THEN 'chief_finance_officer'
                       END;
        v_moved := public.staff_requisition_office_apply_transfer(
          v_office, v_hr,
          'Auto-sync from HR appointment: ' || coalesce(v_title, v_office),
          auth.uid()
        );
        action := 'transferred (' || v_moved || ' prompts)';
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'srq office reconcile failed for %: %', v_office, SQLERRM;
        action := 'error: ' || SQLERRM;
      END;
    END IF;
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$function$;

GRANT EXECUTE ON FUNCTION public.staff_requisition_offices_reconcile(boolean) TO authenticated;

-- 5. Trigger: HR appointment changes re-point the coo/cfo office immediately.
--    Name sorts after hr_assign_sync_access so the role grant lands first.
CREATE OR REPLACE FUNCTION public.tg_hr_assign_sync_requisition_office()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_office text;
  v_offices text[] := ARRAY[]::text[];
  v_key text;
  v_title text;
  v_hr uuid;
  v_current uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT p.key INTO v_key FROM public.hr_positions p WHERE p.id = OLD.position_id;
    IF v_key = 'chief_operations_officer' THEN v_offices := v_offices || 'coo'; END IF;
    IF v_key = 'chief_finance_officer' THEN v_offices := v_offices || 'cfo'; END IF;
  END IF;

  SELECT p.key INTO v_key FROM public.hr_positions p WHERE p.id = NEW.position_id;
  IF v_key = 'chief_operations_officer' AND NOT ('coo' = ANY(v_offices)) THEN v_offices := v_offices || 'coo'; END IF;
  IF v_key = 'chief_finance_officer' AND NOT ('cfo' = ANY(v_offices)) THEN v_offices := v_offices || 'cfo'; END IF;

  FOREACH v_office IN ARRAY v_offices LOOP
    v_hr := public.staff_requisition_office_hr_holder(v_office);
    SELECT o.holder_id INTO v_current
      FROM public.staff_requisition_offices o WHERE o.office_key = v_office;
    IF v_hr IS NOT NULL AND v_current IS DISTINCT FROM v_hr THEN
      SELECT p.title INTO v_title
        FROM public.hr_positions p
       WHERE p.key = CASE v_office
                       WHEN 'coo' THEN 'chief_operations_officer'
                       WHEN 'cfo' THEN 'chief_finance_officer'
                     END;
      -- Errors are NOT swallowed here: a bad appointment must fail visibly
      -- instead of leaving requisition routing stale.
      PERFORM public.staff_requisition_office_apply_transfer(
        v_office, v_hr,
        'Auto-sync from HR appointment: ' || coalesce(v_title, v_office),
        auth.uid()
      );
    END IF;
  END LOOP;

  RETURN NEW;
END
$function$;

CREATE TRIGGER hr_assign_sync_requisition_office
  AFTER INSERT OR UPDATE OF staff_id, position_id, started_on, ended_on, is_primary
  ON public.hr_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_hr_assign_sync_requisition_office();

-- 6. Daily safety net at 00:05 EAT (21:05 UTC), catches future-dated appointments.
-- (Job name verified unused; cron.job is not directly writable from migrations.)
SELECT cron.schedule(
  'srq-office-reconcile-daily',
  '5 21 * * *',
  $$select * from public.staff_requisition_offices_reconcile(true);$$
);
