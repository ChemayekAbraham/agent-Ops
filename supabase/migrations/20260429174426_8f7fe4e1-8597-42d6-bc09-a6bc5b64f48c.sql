-- =====================================================================
-- Background-job pattern for bulk capability changes
-- =====================================================================

-- Job header
CREATE TABLE IF NOT EXISTS public.agent_capability_ops_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL CHECK (action IN ('enable','disable')),
  capabilities text[] NOT NULL,
  agent_ids uuid[] NOT NULL,
  reason text NOT NULL,
  total_agents int NOT NULL,
  total_batches int NOT NULL,
  chunk_size int NOT NULL DEFAULT 1000,
  batches_done int NOT NULL DEFAULT 0,
  affected_total bigint NOT NULL DEFAULT 0,
  failed_total bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  source text NOT NULL DEFAULT 'segment' CHECK (source IN ('segment','csv','manual')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_capjobs_status ON public.agent_capability_ops_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_capjobs_requester ON public.agent_capability_ops_jobs (requested_by, created_at DESC);

-- Per-batch ledger
CREATE TABLE IF NOT EXISTS public.agent_capability_ops_job_batches (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.agent_capability_ops_jobs(id) ON DELETE CASCADE,
  batch_index int NOT NULL,
  capability text NOT NULL,
  agent_count int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  affected int NOT NULL DEFAULT 0,
  error text,
  claimed_at timestamptz,
  finished_at timestamptz,
  UNIQUE (job_id, batch_index, capability)
);

CREATE INDEX IF NOT EXISTS idx_capjob_batches_pending
  ON public.agent_capability_ops_job_batches (job_id, status)
  WHERE status = 'pending';

-- ----- RLS: read for staff, no direct writes -----
ALTER TABLE public.agent_capability_ops_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_capability_ops_job_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read_jobs ON public.agent_capability_ops_jobs;
CREATE POLICY staff_read_jobs ON public.agent_capability_ops_jobs
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'operations')
    OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'super_admin')
  );

DROP POLICY IF EXISTS staff_read_batches ON public.agent_capability_ops_job_batches;
CREATE POLICY staff_read_batches ON public.agent_capability_ops_job_batches
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.agent_capability_ops_jobs j
       WHERE j.id = job_id
         AND (
           j.requested_by = auth.uid()
           OR public.has_role(auth.uid(),'manager')
           OR public.has_role(auth.uid(),'operations')
           OR public.has_role(auth.uid(),'coo')
           OR public.has_role(auth.uid(),'ceo')
           OR public.has_role(auth.uid(),'super_admin')
         )
    )
  );

-- ---------------------------------------------------------------------
-- Enqueue: returns immediately
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_agent_capability_job(
  _agent_ids uuid[],
  _capabilities text[],
  _action text,
  _reason text,
  _source text DEFAULT 'segment',
  _chunk_size int DEFAULT 1000
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job_id uuid;
  _total int;
  _batches int;
  _i int := 1;
  _idx int := 0;
  _cap text;
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  IF _action NOT IN ('enable','disable') THEN
    RAISE EXCEPTION 'action must be enable or disable';
  END IF;
  IF length(coalesce(trim(_reason),'')) < 10 THEN
    RAISE EXCEPTION 'reason must be at least 10 characters';
  END IF;
  IF _agent_ids IS NULL OR array_length(_agent_ids,1) IS NULL THEN
    RAISE EXCEPTION 'no agents supplied';
  END IF;
  IF _capabilities IS NULL OR array_length(_capabilities,1) IS NULL THEN
    RAISE EXCEPTION 'no capabilities supplied';
  END IF;
  IF _chunk_size IS NULL OR _chunk_size < 100 OR _chunk_size > 5000 THEN
    _chunk_size := 1000;
  END IF;

  _total := array_length(_agent_ids, 1);
  _batches := CEIL(_total::numeric / _chunk_size)::int * array_length(_capabilities, 1);

  INSERT INTO public.agent_capability_ops_jobs(
    requested_by, action, capabilities, agent_ids, reason,
    total_agents, total_batches, chunk_size, source
  ) VALUES (
    auth.uid(), _action, _capabilities, _agent_ids, trim(_reason),
    _total, _batches, _chunk_size, COALESCE(_source,'segment')
  ) RETURNING id INTO _job_id;

  -- Pre-create per-(capability,batch) rows
  FOREACH _cap IN ARRAY _capabilities LOOP
    _i := 1;
    _idx := 0;
    WHILE _i <= _total LOOP
      INSERT INTO public.agent_capability_ops_job_batches(
        job_id, batch_index, capability, agent_count
      ) VALUES (
        _job_id, _idx, _cap, LEAST(_chunk_size, _total - _i + 1)
      );
      _i := _i + _chunk_size;
      _idx := _idx + 1;
    END LOOP;
  END LOOP;

  -- Best-effort system event so dashboards refresh
  BEGIN
    INSERT INTO public.system_events(event_type, payload)
    VALUES ('agent_capability_job.enqueued',
            jsonb_build_object('job_id', _job_id, 'total_agents', _total, 'batches', _batches));
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  RETURN _job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_agent_capability_job(uuid[], text[], text, text, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.enqueue_agent_capability_job(uuid[], text[], text, text, text, int) TO authenticated;

-- ---------------------------------------------------------------------
-- Worker claims next batch (atomic)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_next_agent_capability_batch(_job_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _batch record;
  _job   record;
  _slice uuid[];
  _from int;
  _to int;
BEGIN
  SELECT b.* INTO _batch
  FROM public.agent_capability_ops_job_batches b
  JOIN public.agent_capability_ops_jobs j ON j.id = b.job_id
  WHERE b.status = 'pending'
    AND j.status IN ('queued','running')
    AND (_job_id IS NULL OR b.job_id = _job_id)
  ORDER BY j.created_at, b.batch_index
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF _batch.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.agent_capability_ops_job_batches
     SET status = 'running', claimed_at = now()
   WHERE id = _batch.id;

  UPDATE public.agent_capability_ops_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, now())
   WHERE id = _batch.job_id AND status = 'queued';

  SELECT * INTO _job FROM public.agent_capability_ops_jobs WHERE id = _batch.job_id;

  _from := _batch.batch_index * _job.chunk_size + 1;
  _to   := LEAST(_from + _job.chunk_size - 1, _job.total_agents);
  _slice := _job.agent_ids[_from:_to];

  RETURN jsonb_build_object(
    'batch_id', _batch.id,
    'job_id', _batch.job_id,
    'batch_index', _batch.batch_index,
    'capability', _batch.capability,
    'action', _job.action,
    'reason', _job.reason,
    'agent_ids', to_jsonb(_slice)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_agent_capability_batch(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_capability_batch(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- Worker completes a batch
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_agent_capability_batch(
  _batch_id bigint,
  _affected int,
  _error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job_id uuid;
  _total_batches int;
  _done int;
  _failed int;
BEGIN
  UPDATE public.agent_capability_ops_job_batches
     SET status = CASE WHEN _error IS NULL THEN 'done' ELSE 'failed' END,
         affected = COALESCE(_affected, 0),
         error = _error,
         finished_at = now()
   WHERE id = _batch_id
   RETURNING job_id INTO _job_id;

  IF _job_id IS NULL THEN RETURN; END IF;

  UPDATE public.agent_capability_ops_jobs j
     SET batches_done   = batches_done + 1,
         affected_total = affected_total + COALESCE(_affected, 0),
         failed_total   = failed_total + (CASE WHEN _error IS NULL THEN 0 ELSE 1 END),
         last_error     = COALESCE(_error, last_error)
   WHERE j.id = _job_id;

  SELECT total_batches,
         (SELECT count(*) FROM public.agent_capability_ops_job_batches
           WHERE job_id = _job_id AND status IN ('done','failed')),
         (SELECT count(*) FROM public.agent_capability_ops_job_batches
           WHERE job_id = _job_id AND status = 'failed')
    INTO _total_batches, _done, _failed
    FROM public.agent_capability_ops_jobs WHERE id = _job_id;

  IF _done >= _total_batches THEN
    UPDATE public.agent_capability_ops_jobs
       SET status = CASE WHEN _failed > 0 AND _failed = _total_batches THEN 'failed' ELSE 'done' END,
           finished_at = now()
     WHERE id = _job_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_capability_batch(bigint, int, text) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_agent_capability_batch(bigint, int, text) TO authenticated;

-- ---------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_agent_capability_job(_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR EXISTS (SELECT 1 FROM public.agent_capability_ops_jobs
                      WHERE id = _job_id AND requested_by = auth.uid())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  UPDATE public.agent_capability_ops_jobs
     SET status = 'cancelled', finished_at = now()
   WHERE id = _job_id AND status IN ('queued','running');
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_agent_capability_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.cancel_agent_capability_job(uuid) TO authenticated;

-- Realtime so dashboard polling can be replaced by subscription if desired
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_capability_ops_jobs;