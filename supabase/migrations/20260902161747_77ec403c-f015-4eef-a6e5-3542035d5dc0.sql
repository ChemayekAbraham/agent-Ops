CREATE OR REPLACE FUNCTION public.agent_ops_prior_period_start(p_granularity text, p_period_start date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE p_granularity
    WHEN 'daily' THEN p_period_start - INTERVAL '1 day'
    WHEN 'weekly' THEN p_period_start - INTERVAL '7 days'
    WHEN 'monthly' THEN p_period_start - INTERVAL '1 month'
  END::date
$fn$;

CREATE OR REPLACE FUNCTION public.agent_ops_prior_report(p_granularity text, p_period_start date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT r.id
  FROM public.agent_ops_reports r
  WHERE r.granularity = p_granularity
    AND r.period_start = public.agent_ops_prior_period_start(p_granularity, p_period_start)
  LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.agent_ops_open_report(p_granularity text, p_period_start date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_existing uuid;
  v_snapshot_id uuid;
  v_prior_snapshot_id uuid;
  v_prior_start date;
  v_period_end date;
  v_target integer;
  v_report_id uuid;
BEGIN
  IF p_granularity IS NULL OR p_granularity NOT IN ('daily','weekly','monthly') THEN
    RAISE EXCEPTION 'Choose a report period type of daily, weekly or monthly.';
  END IF;
  IF p_period_start IS NULL THEN
    RAISE EXCEPTION 'Choose the date the report period starts.';
  END IF;

  SELECT id INTO v_existing
  FROM public.agent_ops_reports
  WHERE granularity = p_granularity AND period_start = p_period_start;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_snapshot_id := public.agent_ops_compute_snapshot(p_granularity, p_period_start);

  v_prior_start := public.agent_ops_prior_period_start(p_granularity, p_period_start);
  BEGIN
    v_prior_snapshot_id := public.agent_ops_compute_snapshot(p_granularity, v_prior_start);
  EXCEPTION WHEN OTHERS THEN
    v_prior_snapshot_id := NULL;
  END;

  SELECT period_end INTO v_period_end
  FROM public.agent_ops_period_snapshots
  WHERE id = v_snapshot_id;

  SELECT target_net_agents INTO v_target
  FROM public.agent_ops_period_targets
  WHERE granularity = p_granularity AND period_start = p_period_start
  LIMIT 1;

  INSERT INTO public.agent_ops_reports (
    granularity, period_start, period_end, snapshot_id, prior_snapshot_id, target_net_agents, status
  ) VALUES (
    p_granularity, p_period_start, v_period_end, v_snapshot_id, v_prior_snapshot_id, v_target, 'draft'
  )
  ON CONFLICT (granularity, period_start) DO NOTHING
  RETURNING id INTO v_report_id;

  IF v_report_id IS NULL THEN
    SELECT id INTO v_report_id
    FROM public.agent_ops_reports
    WHERE granularity = p_granularity AND period_start = p_period_start;
  END IF;

  RETURN v_report_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.agent_ops_submit_report(p_report_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_report public.agent_ops_reports;
  v_prior_report_id uuid;
  v_zone text;
  v_note text;
  v_prior_note text;
  v_action_count integer;
  v_unclosed integer;
BEGIN
  SELECT * INTO v_report FROM public.agent_ops_reports WHERE id = p_report_id;
  IF v_report.id IS NULL THEN
    RAISE EXCEPTION 'That report could not be found.';
  END IF;
  IF v_report.status = 'submitted' THEN
    RAISE EXCEPTION 'This report has already been submitted and cannot be submitted again.';
  END IF;

  v_prior_report_id := public.agent_ops_prior_report(v_report.granularity, v_report.period_start);

  FOREACH v_zone IN ARRAY ARRAY['growth','pipeline'] LOOP
    SELECT reason_note INTO v_note
    FROM public.agent_ops_report_notes
    WHERE report_id = p_report_id AND zone = v_zone;

    IF v_note IS NULL THEN
      RAISE EXCEPTION 'Write the % explanation before submitting. It must be at least 80 characters.', v_zone;
    END IF;
    IF char_length(btrim(v_note)) < 80 THEN
      RAISE EXCEPTION 'The % explanation is too short. Write at least 80 characters explaining what happened and why.', v_zone;
    END IF;

    IF v_prior_report_id IS NOT NULL THEN
      SELECT reason_note INTO v_prior_note
      FROM public.agent_ops_report_notes
      WHERE report_id = v_prior_report_id AND zone = v_zone;

      IF v_prior_note IS NOT NULL AND v_prior_note = v_note THEN
        RAISE EXCEPTION 'The % explanation is copied word-for-word from the previous report. Write a fresh explanation for this period.', v_zone;
      END IF;
    END IF;

    SELECT count(*) INTO v_action_count
    FROM public.agent_ops_report_actions
    WHERE report_id = p_report_id
      AND zone = v_zone
      AND char_length(btrim(coalesce(item_text,''))) > 0
      AND due_date IS NOT NULL
      AND (owner_staff_id IS NOT NULL OR char_length(btrim(coalesce(owner_label,''))) > 0);

    IF v_action_count = 0 THEN
      RAISE EXCEPTION 'Add at least one % action with what will be done, who owns it and a due date.', v_zone;
    END IF;
  END LOOP;

  IF v_prior_report_id IS NOT NULL THEN
    SELECT count(*) INTO v_unclosed
    FROM public.agent_ops_report_actions
    WHERE report_id = v_prior_report_id
      AND (outcome IS NULL OR char_length(btrim(coalesce(outcome_note,''))) = 0);

    IF v_unclosed > 0 THEN
      RAISE EXCEPTION 'Close out every action from the previous report first: each one needs an outcome and a short note on what happened.';
    END IF;
  END IF;

  UPDATE public.agent_ops_reports
  SET status = 'submitted',
      submitted_at = now(),
      submitted_by = auth.uid(),
      updated_at = now()
  WHERE id = p_report_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.agent_ops_report_locked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_report_id uuid;
  v_status text;
BEGIN
  v_report_id := COALESCE(NEW.report_id, OLD.report_id);
  SELECT status INTO v_status FROM public.agent_ops_reports WHERE id = v_report_id;
  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'This report has been submitted and can no longer be changed.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS trg_agent_ops_report_notes_locked ON public.agent_ops_report_notes;
CREATE TRIGGER trg_agent_ops_report_notes_locked
BEFORE INSERT OR UPDATE OR DELETE ON public.agent_ops_report_notes
FOR EACH ROW EXECUTE FUNCTION public.agent_ops_report_locked();

DROP TRIGGER IF EXISTS trg_agent_ops_report_actions_locked ON public.agent_ops_report_actions;
CREATE TRIGGER trg_agent_ops_report_actions_locked
BEFORE INSERT OR UPDATE OR DELETE ON public.agent_ops_report_actions
FOR EACH ROW EXECUTE FUNCTION public.agent_ops_report_locked();

CREATE OR REPLACE FUNCTION public.agent_ops_carry_actions(p_report_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_report public.agent_ops_reports;
  v_prior_report_id uuid;
  v_row record;
  v_inserted integer := 0;
  v_new_id uuid;
  v_prior_outcome text;
BEGIN
  SELECT * INTO v_report FROM public.agent_ops_reports WHERE id = p_report_id;
  IF v_report.id IS NULL THEN
    RAISE EXCEPTION 'That report could not be found.';
  END IF;
  IF v_report.status = 'submitted' THEN
    RAISE EXCEPTION 'This report has been submitted and can no longer be changed.';
  END IF;

  v_prior_report_id := public.agent_ops_prior_report(v_report.granularity, v_report.period_start);
  IF v_prior_report_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT a.*
    FROM public.agent_ops_report_actions a
    WHERE a.report_id = v_prior_report_id
      AND a.closed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_ops_report_actions c
        WHERE c.report_id = p_report_id AND c.carried_from_action_id = a.id
      )
  LOOP
    INSERT INTO public.agent_ops_report_actions (
      report_id, zone, item_text, owner_staff_id, owner_label, due_date, carried_from_action_id
    ) VALUES (
      p_report_id, v_row.zone, v_row.item_text, v_row.owner_staff_id, v_row.owner_label,
      GREATEST(v_row.due_date, v_report.period_end), v_row.id
    )
    RETURNING id INTO v_new_id;

    v_inserted := v_inserted + 1;

    IF v_row.outcome IN ('not_done','partly_done') AND v_row.carried_from_action_id IS NOT NULL THEN
      SELECT outcome INTO v_prior_outcome
      FROM public.agent_ops_report_actions
      WHERE id = v_row.carried_from_action_id;

      IF v_prior_outcome IN ('not_done','partly_done') THEN
        UPDATE public.agent_ops_report_actions
        SET reviewer_notified_at = now()
        WHERE id = v_new_id;
      END IF;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$fn$;