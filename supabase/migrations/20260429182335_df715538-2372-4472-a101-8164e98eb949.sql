-- ============================================================
-- 1. Snapshot table — prior state of each agent_capabilities row
--    that a bulk job touched. Used for precise revert.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_capability_ops_undo_snapshots (
  id              bigserial PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES public.agent_capability_ops_jobs(id) ON DELETE CASCADE,
  batch_id        bigint REFERENCES public.agent_capability_ops_job_batches(id) ON DELETE SET NULL,
  capability      text NOT NULL,
  agent_id        uuid NOT NULL,
  op              text NOT NULL CHECK (op IN ('insert','update')),
  prior_status    text,
  prior_granted_by uuid,
  prior_revoked_by uuid,
  prior_granted_at timestamptz,
  prior_revoked_at timestamptz,
  prior_metadata  jsonb,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capundo_job ON public.agent_capability_ops_undo_snapshots (job_id);
CREATE INDEX IF NOT EXISTS idx_capundo_lookup ON public.agent_capability_ops_undo_snapshots (job_id, capability, agent_id);

ALTER TABLE public.agent_capability_ops_undo_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_undo_snapshots" ON public.agent_capability_ops_undo_snapshots;
CREATE POLICY "staff_read_undo_snapshots"
  ON public.agent_capability_ops_undo_snapshots
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ============================================================
-- 2. Track undo state on the jobs table
-- ============================================================
ALTER TABLE public.agent_capability_ops_jobs
  ADD COLUMN IF NOT EXISTS undone_at   timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by   uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS undo_reason text;

-- ============================================================
-- 3. Trigger: snapshot prior state of each row that is touched
--    while a bulk job is running. Activated only when the GUC
--    `app.capability_ops_job_id` is set on the session — so
--    one-off manual edits are NEVER snapshotted.
-- ============================================================
CREATE OR REPLACE FUNCTION public.snapshot_agent_capability_for_undo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id_text text;
  v_job_id      uuid;
BEGIN
  v_job_id_text := current_setting('app.capability_ops_job_id', true);
  IF v_job_id_text IS NULL OR v_job_id_text = '' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  BEGIN
    v_job_id := v_job_id_text::uuid;
  EXCEPTION WHEN others THEN
    RETURN COALESCE(NEW, OLD);
  END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.agent_capability_ops_undo_snapshots
      (job_id, capability, agent_id, op,
       prior_status, prior_granted_by, prior_revoked_by,
       prior_granted_at, prior_revoked_at, prior_metadata)
    VALUES
      (v_job_id, NEW.capability, NEW.agent_id, 'insert',
       NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only snapshot meaningful changes
    IF OLD.status IS DISTINCT FROM NEW.status
       OR OLD.granted_by IS DISTINCT FROM NEW.granted_by
       OR OLD.revoked_by IS DISTINCT FROM NEW.revoked_by THEN
      INSERT INTO public.agent_capability_ops_undo_snapshots
        (job_id, capability, agent_id, op,
         prior_status, prior_granted_by, prior_revoked_by,
         prior_granted_at, prior_revoked_at, prior_metadata)
      VALUES
        (v_job_id, OLD.capability, OLD.agent_id, 'update',
         OLD.status, OLD.granted_by, OLD.revoked_by,
         OLD.granted_at, OLD.revoked_at, OLD.metadata);
    END IF;
    RETURN NEW;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_snapshot_agent_capability_for_undo ON public.agent_capabilities;
CREATE TRIGGER trg_snapshot_agent_capability_for_undo
  BEFORE INSERT OR UPDATE ON public.agent_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_agent_capability_for_undo();

-- ============================================================
-- 4. Patch the existing bulk RPC to set the GUC for the
--    duration of the call so the snapshot trigger fires.
--    Everything else is preserved exactly as it was.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_bulk_set_agent_capability(
  _agent_ids uuid[], _capability text, _action text, _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_n      integer := COALESCE(array_length(_agent_ids,1), 0);
  v_aff    integer := 0;
  v_job_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT (
    public.has_role(v_actor,'manager'::app_role)
    OR public.has_role(v_actor,'coo'::app_role)
    OR public.has_role(v_actor,'super_admin'::app_role)
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN RAISE EXCEPTION 'reason must be at least 10 characters'; END IF;
  IF _action NOT IN ('enable','disable') THEN RAISE EXCEPTION 'action must be enable or disable'; END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'no agents selected'; END IF;
  IF v_n > 5000 THEN RAISE EXCEPTION 'batch limit is 5000 agents per call'; END IF;

  -- Best-effort: derive the parent job id from the most recent open job
  -- whose agent_ids/capability/action match this call. Used only to tag
  -- the per-row snapshots written by the trigger.
  SELECT j.id INTO v_job_id
  FROM public.agent_capability_ops_jobs j
  WHERE j.requested_by = v_actor
    AND j.action       = _action
    AND _capability    = ANY(j.capabilities)
    AND j.created_at  >= now() - interval '4 hours'
    AND j.undone_at   IS NULL
  ORDER BY j.created_at DESC
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM set_config('app.capability_ops_job_id', v_job_id::text, true);
  END IF;

  IF _action = 'enable' THEN
    WITH ins AS (
      INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_by, metadata)
      SELECT a, _capability, 'active', v_actor,
             jsonb_build_object('source','manual','reason',_reason,'bulk',true)
      FROM unnest(_agent_ids) AS a
      ON CONFLICT (agent_id, capability) DO UPDATE
        SET status='active', revoked_at=NULL, revoked_by=NULL,
            granted_by=v_actor,
            metadata = public.agent_capabilities.metadata
                     || jsonb_build_object('source','manual','reason',_reason,'bulk',true),
            updated_at=now()
      RETURNING agent_id
    )
    SELECT count(*) INTO v_aff FROM ins;
  ELSE
    WITH upd AS (
      UPDATE public.agent_capabilities
         SET status='suspended', revoked_at=now(), revoked_by=v_actor,
             metadata = metadata || jsonb_build_object('source','manual','reason',_reason,'bulk',true)
       WHERE capability=_capability AND agent_id = ANY(_agent_ids)
       RETURNING agent_id
    )
    SELECT count(*) INTO v_aff FROM upd;
  END IF;

  -- Clear the GUC so it never leaks to a later statement on this connection.
  PERFORM set_config('app.capability_ops_job_id', '', true);

  -- Bulk audit (one row per agent) — kept identical to the prior RPC.
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  SELECT 'agent_capability_' || _action, 'agent_capabilities', a, v_actor,
         jsonb_build_object('capability',_capability,'agent_id',a,'bulk',true,'reason',_reason)
  FROM unnest(_agent_ids) AS a;

  -- Bulk system event (one row per agent)
  INSERT INTO public.system_events (event_type, source_type, source_id, payload)
  SELECT 'agent.capability.changed','agent_ops', a,
         jsonb_build_object('agent_id',a,'capability',_capability,'action',_action,
                            'actor',v_actor,'reason',_reason,'bulk',true,
                            'job_id', v_job_id)
  FROM unnest(_agent_ids) AS a;

  RETURN jsonb_build_object('ok',true,'requested',v_n,'affected',v_aff,
                            'capability',_capability,'action',_action,
                            'job_id', v_job_id);
END $function$;

-- ============================================================
-- 5. Undo RPC — within 15 minutes of job finish, restore each
--    snapshotted (agent, capability) row to its prior state.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_undo_agent_capability_job(
  _job_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_job      record;
  v_now      timestamptz := now();
  v_window   interval := interval '15 minutes';
  v_restored integer := 0;
  v_deleted  integer := 0;
  v_total    integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT (
    public.has_role(v_actor,'manager'::app_role)
    OR public.has_role(v_actor,'coo'::app_role)
    OR public.has_role(v_actor,'super_admin'::app_role)
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_job FROM public.agent_capability_ops_jobs WHERE id = _job_id FOR UPDATE;
  IF v_job IS NULL THEN RAISE EXCEPTION 'job not found'; END IF;
  IF v_job.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'job already undone at %', v_job.undone_at;
  END IF;
  IF v_job.status NOT IN ('done','failed','cancelled') THEN
    RAISE EXCEPTION 'job is still %, wait for it to finish first', v_job.status;
  END IF;
  IF v_job.finished_at IS NULL OR v_now - v_job.finished_at > v_window THEN
    RAISE EXCEPTION 'undo window has expired (15 minutes after finish)';
  END IF;

  -- Block the snapshot trigger from re-firing during the restore.
  PERFORM set_config('app.capability_ops_job_id', '', true);

  -- 5a. For rows that originally did not exist: delete the row the job inserted,
  --     but only if it still looks job-tagged and untouched since then.
  WITH del AS (
    DELETE FROM public.agent_capabilities ac
    USING public.agent_capability_ops_undo_snapshots s
    WHERE s.job_id = _job_id
      AND s.op     = 'insert'
      AND ac.agent_id   = s.agent_id
      AND ac.capability = s.capability
      AND ac.updated_at <= v_job.finished_at + interval '5 minutes'
    RETURNING ac.id
  )
  SELECT count(*) INTO v_deleted FROM del;

  -- 5b. For rows that existed before: restore prior status + actor fields,
  --     only if no later non-job edit has happened.
  WITH restore AS (
    UPDATE public.agent_capabilities ac
       SET status      = s.prior_status,
           granted_by  = s.prior_granted_by,
           revoked_by  = s.prior_revoked_by,
           granted_at  = COALESCE(s.prior_granted_at, ac.granted_at),
           revoked_at  = s.prior_revoked_at,
           metadata    = COALESCE(s.prior_metadata, '{}'::jsonb)
                       || jsonb_build_object('undone_from_job', _job_id,
                                             'undone_at', v_now,
                                             'undone_reason', _reason),
           updated_at  = v_now
      FROM public.agent_capability_ops_undo_snapshots s
     WHERE s.job_id = _job_id
       AND s.op     = 'update'
       AND ac.agent_id   = s.agent_id
       AND ac.capability = s.capability
       AND ac.updated_at <= v_job.finished_at + interval '5 minutes'
     RETURNING ac.id
  )
  SELECT count(*) INTO v_restored FROM restore;

  SELECT count(*) INTO v_total
  FROM public.agent_capability_ops_undo_snapshots
  WHERE job_id = _job_id;

  -- Mark the job as undone
  UPDATE public.agent_capability_ops_jobs
     SET undone_at = v_now,
         undone_by = v_actor,
         undo_reason = _reason
   WHERE id = _job_id;

  -- Audit + event
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'agent_capability_job_undone',
    'agent_capability_ops_jobs',
    _job_id,
    v_actor,
    jsonb_build_object(
      'job_id', _job_id,
      'reason', _reason,
      'restored', v_restored,
      'deleted',  v_deleted,
      'snapshot_total', v_total
    )
  );

  INSERT INTO public.system_events (event_type, source_type, source_id, payload)
  VALUES (
    'agent.capability.job.undone',
    'agent_ops',
    _job_id,
    jsonb_build_object(
      'job_id', _job_id,
      'undone_by', v_actor,
      'reason', _reason,
      'restored', v_restored,
      'deleted',  v_deleted,
      'snapshot_total', v_total,
      'window_minutes', 15
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'job_id', _job_id,
    'restored', v_restored,
    'deleted',  v_deleted,
    'snapshot_total', v_total
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.ops_undo_agent_capability_job(uuid, text) TO authenticated;