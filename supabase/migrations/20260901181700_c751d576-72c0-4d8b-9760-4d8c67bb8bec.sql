-- TPPO-A-P20
-- 1) Idempotency stamp on TPPO report actions.
ALTER TABLE public.tppo_report_actions
  ADD COLUMN IF NOT EXISTS reviewer_notified_at timestamptz;

-- 2) Raise a stalled collections action to COO role holders through the existing
--    in-app notification mechanism (public.notifications), exactly once per action.
CREATE OR REPLACE FUNCTION public.tppo_notify_reviewer_on_overdue_actions(p_report_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_action record;
  v_owner text;
  v_message text;
  v_notified integer := 0;
BEGIN
  FOR v_action IN
    SELECT
      a.id,
      a.item_text,
      a.due_date,
      a.owner_label,
      a.owner_staff_id,
      r.granularity,
      r.period_start
    FROM public.tppo_report_actions a
    JOIN public.tppo_reports r ON r.id = a.report_id
    JOIN public.tppo_report_actions pa ON pa.id = a.carried_from_action_id
    JOIN public.tppo_reports pr ON pr.id = pa.report_id
    LEFT JOIN public.tppo_report_actions ga ON ga.id = pa.carried_from_action_id
    WHERE a.report_id = p_report_id
      AND a.zone = 'collections'
      AND a.outcome = 'not_done'
      AND a.reviewer_notified_at IS NULL
      AND pa.outcome = 'not_done'
      AND pr.granularity = r.granularity
      AND pr.period_start = (CASE r.granularity
            WHEN 'day'   THEN r.period_start - INTERVAL '1 day'
            WHEN 'week'  THEN r.period_start - INTERVAL '7 days'
            ELSE              r.period_start - INTERVAL '1 month'
          END)::date
      -- exactly two consecutive: a longer chain was already raised at its second link
      AND (ga.id IS NULL OR ga.outcome IS DISTINCT FROM 'not_done')
  LOOP
    v_owner := COALESCE(
      NULLIF(btrim(COALESCE(v_action.owner_label, '')), ''),
      (SELECT NULLIF(btrim(COALESCE(p.full_name, '')), '')
         FROM public.hr_staff s
         JOIN public.profiles p ON p.id = s.user_id
        WHERE s.id = v_action.owner_staff_id),
      'unassigned'
    );

    v_message :=
      'Tenant portfolio report — an action has been outstanding for two consecutive periods: "'
      || v_action.item_text || '", owner ' || v_owner
      || ', due ' || COALESCE(v_action.due_date::text, 'not set')
      || '. Period ' || v_action.granularity
      || ' beginning ' || v_action.period_start::text || '.';

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    SELECT
      ur.user_id,
      'Tenant portfolio report — action outstanding',
      v_message,
      'info',
      jsonb_build_object(
        'tppo_report_id', p_report_id,
        'tppo_action_id', v_action.id,
        'granularity', v_action.granularity,
        'period_start', v_action.period_start
      )
    FROM public.user_roles ur
    WHERE ur.role = 'coo'
      AND COALESCE(ur.enabled, true) IS TRUE;

    UPDATE public.tppo_report_actions
       SET reviewer_notified_at = now()
     WHERE id = v_action.id;

    v_notified := v_notified + 1;
  END LOOP;

  RETURN v_notified;
END;
$function$;

REVOKE ALL ON FUNCTION public.tppo_notify_reviewer_on_overdue_actions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tppo_notify_reviewer_on_overdue_actions(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.tppo_notify_reviewer_on_overdue_actions(uuid) TO authenticated, service_role;