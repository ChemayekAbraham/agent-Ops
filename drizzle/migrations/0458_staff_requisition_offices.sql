CREATE TABLE public.staff_requisition_offices (
  office_key text PRIMARY KEY CHECK (office_key IN ('coo','ceo','cfo')),
  office_code text UNIQUE NOT NULL,
  holder_id uuid NOT NULL,
  holder_since timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_requisition_offices_holder_uq ON public.staff_requisition_offices (holder_id);
GRANT SELECT ON public.staff_requisition_offices TO authenticated;
GRANT ALL ON public.staff_requisition_offices TO service_role;
ALTER TABLE public.staff_requisition_offices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read requisition offices" ON public.staff_requisition_offices
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.staff_requisition_offices (office_key, office_code, holder_id) VALUES
  ('coo','OFF-COO','b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c'),
  ('ceo','OFF-CEO','cf561688-b3a2-4f62-b9c1-67ee7b36ff2b'),
  ('cfo','OFF-CFO','29a0cfa8-1eaf-453c-874c-0fc72fa4f74b');

CREATE TABLE public.staff_requisition_office_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_key text NOT NULL,
  from_holder uuid,
  to_holder uuid NOT NULL,
  reason text NOT NULL,
  transferred_by uuid NOT NULL,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  prompts_moved int NOT NULL DEFAULT 0
);
GRANT SELECT ON public.staff_requisition_office_history TO authenticated;
GRANT ALL ON public.staff_requisition_office_history TO service_role;
ALTER TABLE public.staff_requisition_office_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read requisition office history" ON public.staff_requisition_office_history
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.tg_staff_requisition_prompt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entered boolean := false;
  v_eligible integer := 0;
BEGIN
  IF coalesce(NEW.request_kind, 'requisition') <> 'requisition' THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage
       AND OLD.stage IN ('coo','ceo','cfo') THEN
      UPDATE public.staff_requisition_prompts
         SET state = 'resolved', resolved_at = now(), resolution = NEW.stage
       WHERE requisition_id = NEW.id
         AND stage = OLD.stage
         AND state <> 'resolved';
    END IF;

    v_entered := NEW.stage IN ('coo','ceo','cfo')
      AND (TG_OP = 'INSERT' OR OLD.stage IS DISTINCT FROM NEW.stage);

    IF v_entered THEN
      SELECT count(*) INTO v_eligible
        FROM public.staff_requisition_offices o
       WHERE o.office_key = NEW.stage
         AND public.has_role(o.holder_id, NEW.stage::app_role)
         AND o.holder_id <> NEW.requester_id
         AND o.holder_id IS DISTINCT FROM NEW.supervisor_decided_by
         AND o.holder_id IS DISTINCT FROM NEW.coo_decided_by
         AND o.holder_id IS DISTINCT FROM NEW.ceo_decided_by;

      IF v_eligible = 0 THEN
        INSERT INTO public.staff_requisition_events (requisition_id, action, actor_name, stage, comment)
        VALUES (
          NEW.id, 'comment', 'System', NEW.stage,
          'No eligible named approver to prompt at ' || upper(NEW.stage) || ' stage.'
        );
      ELSE
        WITH eligible AS (
          SELECT o.holder_id AS user_id
            FROM public.staff_requisition_offices o
           WHERE o.office_key = NEW.stage
             AND public.has_role(o.holder_id, NEW.stage::app_role)
             AND o.holder_id <> NEW.requester_id
             AND o.holder_id IS DISTINCT FROM NEW.supervisor_decided_by
             AND o.holder_id IS DISTINCT FROM NEW.coo_decided_by
             AND o.holder_id IS DISTINCT FROM NEW.ceo_decided_by
        )
        INSERT INTO public.staff_requisition_prompts (requisition_id, approver_id, stage)
        SELECT NEW.id, e.user_id, NEW.stage FROM eligible e
        ON CONFLICT (requisition_id, approver_id, stage) DO UPDATE
          SET state = 'open',
              snooze_until = NULL,
              resolved_at = NULL,
              resolution = NULL,
              last_pushed_at = NULL;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_staff_requisition_prompt skipped for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.staff_requisition_office_transfer(p_office text, p_new_holder uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_old uuid;
  v_name text;
  v_moved integer := 0;
  r record;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.staff_requisition_offices WHERE office_key = 'ceo' AND holder_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the CEO office can transfer offices.';
  END IF;

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
     SET holder_id = p_new_holder, holder_since = now(), updated_by = auth.uid(), updated_at = now()
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
  VALUES (p_office, v_old, p_new_holder, trim(p_reason), auth.uid(), v_moved);

  RETURN v_moved;
END
$function$;
REVOKE ALL ON FUNCTION public.staff_requisition_office_transfer(text, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_office_transfer(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_requisition_offices_list()
 RETURNS TABLE(office_key text, office_code text, holder_id uuid, holder_name text, holder_since timestamptz, can_transfer boolean)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT o.office_key, o.office_code, o.holder_id, p.full_name, o.holder_since,
         EXISTS (SELECT 1 FROM public.staff_requisition_offices c
                  WHERE c.office_key = 'ceo' AND c.holder_id = auth.uid())
    FROM public.staff_requisition_offices o
    LEFT JOIN public.profiles p ON p.id = o.holder_id
   ORDER BY array_position(ARRAY['coo','ceo','cfo'], o.office_key);
$function$;
REVOKE ALL ON FUNCTION public.staff_requisition_offices_list() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_offices_list() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_requisition_office_candidates(p_office text)
 RETURNS TABLE(user_id uuid, full_name text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.staff_requisition_offices WHERE office_key = 'ceo' AND holder_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the CEO office can transfer offices.';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ur.user_id, p.full_name
    FROM public.user_roles ur
    LEFT JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role::text = p_office
     AND ur.enabled
     AND NOT EXISTS (SELECT 1 FROM public.staff_requisition_offices o WHERE o.holder_id = ur.user_id)
   ORDER BY p.full_name;
END
$function$;
REVOKE ALL ON FUNCTION public.staff_requisition_office_candidates(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_office_candidates(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_requisition_prompt_snooze()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_until timestamptz := now() + interval '1 hour';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in.';
  END IF;

  UPDATE public.staff_requisition_prompts
     SET state = 'snoozed',
         snooze_until = v_until,
         snooze_count = snooze_count + 1
   WHERE approver_id = auth.uid()
     AND state <> 'resolved';

  RETURN v_until;
END
$function$;