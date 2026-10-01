CREATE OR REPLACE FUNCTION public.tg_staff_requisition_prompt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
        FROM public.staff_requisition_prompt_authorities a
       WHERE a.stage = NEW.stage
         AND a.enabled
         AND public.has_role(a.user_id, NEW.stage::app_role)
         AND a.user_id <> NEW.requester_id
         AND a.user_id IS DISTINCT FROM NEW.supervisor_decided_by
         AND a.user_id IS DISTINCT FROM NEW.coo_decided_by
         AND a.user_id IS DISTINCT FROM NEW.ceo_decided_by;

      IF v_eligible = 0 THEN
        INSERT INTO public.staff_requisition_events (requisition_id, action, actor_name, stage, comment)
        VALUES (
          NEW.id, 'comment', 'System', NEW.stage,
          'No eligible named approver to prompt at ' || upper(NEW.stage) || ' stage.'
        );
      ELSE
        WITH eligible AS (
          SELECT a.user_id
            FROM public.staff_requisition_prompt_authorities a
           WHERE a.stage = NEW.stage
             AND a.enabled
             AND public.has_role(a.user_id, NEW.stage::app_role)
             AND a.user_id <> NEW.requester_id
             AND a.user_id IS DISTINCT FROM NEW.supervisor_decided_by
             AND a.user_id IS DISTINCT FROM NEW.coo_decided_by
             AND a.user_id IS DISTINCT FROM NEW.ceo_decided_by
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
$$;