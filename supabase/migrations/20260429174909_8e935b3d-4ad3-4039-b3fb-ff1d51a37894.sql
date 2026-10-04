-- Drop old version to allow return type change
DROP FUNCTION IF EXISTS public.complete_agent_capability_batch(bigint, int, text);

-- Add retry/backoff tracking to batches
ALTER TABLE public.agent_capability_ops_job_batches
  ADD COLUMN IF NOT EXISTS attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

ALTER TABLE public.agent_capability_ops_job_batches
  DROP CONSTRAINT IF EXISTS agent_capability_ops_job_batches_status_check;
ALTER TABLE public.agent_capability_ops_job_batches
  ADD CONSTRAINT agent_capability_ops_job_batches_status_check
  CHECK (status IN ('pending','running','done','failed','dead_letter'));

DROP INDEX IF EXISTS idx_capjob_batches_pending;
CREATE INDEX IF NOT EXISTS idx_capjob_batches_ready
  ON public.agent_capability_ops_job_batches (next_attempt_at NULLS FIRST, job_id, batch_index)
  WHERE status = 'pending';

-- Dead-letter table
CREATE TABLE IF NOT EXISTS public.agent_capability_ops_dead_letters (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.agent_capability_ops_jobs(id) ON DELETE CASCADE,
  batch_id bigint NOT NULL REFERENCES public.agent_capability_ops_job_batches(id) ON DELETE CASCADE,
  capability text NOT NULL,
  action text NOT NULL,
  agent_ids uuid[] NOT NULL,
  attempt_count int NOT NULL,
  last_error text,
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('requeued','archived'))
);

CREATE INDEX IF NOT EXISTS idx_capjob_deadletter_open
  ON public.agent_capability_ops_dead_letters (created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE public.agent_capability_ops_dead_letters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read_dead_letters ON public.agent_capability_ops_dead_letters;
CREATE POLICY staff_read_dead_letters ON public.agent_capability_ops_dead_letters
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'operations')
    OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- Claim with backoff window
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
    AND (b.next_attempt_at IS NULL OR b.next_attempt_at <= now())
    AND j.status IN ('queued','running')
    AND (_job_id IS NULL OR b.job_id = _job_id)
  ORDER BY j.created_at, b.batch_index
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF _batch.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.agent_capability_ops_job_batches
     SET status = 'running',
         claimed_at = now(),
         attempt_count = attempt_count + 1
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
    'attempt', _batch.attempt_count + 1,
    'max_attempts', _batch.max_attempts,
    'agent_ids', to_jsonb(_slice)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_agent_capability_batch(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_capability_batch(uuid) TO authenticated;

-- Complete: success | retry-with-backoff | dead-letter
CREATE OR REPLACE FUNCTION public.complete_agent_capability_batch(
  _batch_id bigint,
  _affected int,
  _error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _b record;
  _job record;
  _backoff_seconds int;
  _outcome text;
  _total_batches int;
  _terminal int;
  _failed int;
  _slice uuid[];
  _from int;
  _to int;
BEGIN
  SELECT * INTO _b FROM public.agent_capability_ops_job_batches WHERE id = _batch_id FOR UPDATE;
  IF _b.id IS NULL THEN
    RETURN jsonb_build_object('outcome','unknown_batch');
  END IF;

  IF _error IS NULL THEN
    UPDATE public.agent_capability_ops_job_batches
       SET status = 'done',
           affected = COALESCE(_affected,0),
           error = NULL,
           last_error = NULL,
           finished_at = now()
     WHERE id = _batch_id;
    _outcome := 'done';
  ELSIF _b.attempt_count >= _b.max_attempts THEN
    UPDATE public.agent_capability_ops_job_batches
       SET status = 'dead_letter',
           error = _error,
           last_error = _error,
           dead_lettered_at = now(),
           finished_at = now()
     WHERE id = _batch_id;

    SELECT * INTO _job FROM public.agent_capability_ops_jobs WHERE id = _b.job_id;
    _from := _b.batch_index * _job.chunk_size + 1;
    _to   := LEAST(_from + _job.chunk_size - 1, _job.total_agents);
    _slice := _job.agent_ids[_from:_to];

    INSERT INTO public.agent_capability_ops_dead_letters(
      job_id, batch_id, capability, action, agent_ids,
      attempt_count, last_error, reason, requested_by
    ) VALUES (
      _b.job_id, _b.id, _b.capability, _job.action, _slice,
      _b.attempt_count, _error, _job.reason, _job.requested_by
    );

    BEGIN
      INSERT INTO public.system_events(event_type, payload)
      VALUES ('agent_capability_job.dead_letter',
              jsonb_build_object(
                'job_id', _b.job_id,
                'batch_id', _b.id,
                'capability', _b.capability,
                'attempts', _b.attempt_count,
                'error', _error
              ));
    EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END;
    _outcome := 'dead_letter';
  ELSE
    _backoff_seconds := LEAST(30 * power(2, _b.attempt_count - 1)::int, 480);
    UPDATE public.agent_capability_ops_job_batches
       SET status = 'pending',
           error = _error,
           last_error = _error,
           next_attempt_at = now() + make_interval(secs => _backoff_seconds),
           claimed_at = NULL
     WHERE id = _batch_id;
    _outcome := 'retry_scheduled';
  END IF;

  UPDATE public.agent_capability_ops_jobs j
     SET batches_done = (
           SELECT count(*) FROM public.agent_capability_ops_job_batches
            WHERE job_id = j.id AND status IN ('done','dead_letter')
         ),
         affected_total = (
           SELECT COALESCE(SUM(affected),0) FROM public.agent_capability_ops_job_batches
            WHERE job_id = j.id AND status = 'done'
         ),
         failed_total = (
           SELECT count(*) FROM public.agent_capability_ops_job_batches
            WHERE job_id = j.id AND status = 'dead_letter'
         ),
         last_error = COALESCE(_error, last_error)
   WHERE j.id = _b.job_id;

  SELECT total_batches,
         (SELECT count(*) FROM public.agent_capability_ops_job_batches
           WHERE job_id = _b.job_id AND status IN ('done','dead_letter')),
         (SELECT count(*) FROM public.agent_capability_ops_job_batches
           WHERE job_id = _b.job_id AND status = 'dead_letter')
    INTO _total_batches, _terminal, _failed
    FROM public.agent_capability_ops_jobs WHERE id = _b.job_id;

  IF _terminal >= _total_batches THEN
    UPDATE public.agent_capability_ops_jobs
       SET status = CASE WHEN _failed = _total_batches THEN 'failed' ELSE 'done' END,
           finished_at = now()
     WHERE id = _b.job_id;
  END IF;

  RETURN jsonb_build_object('outcome', _outcome, 'attempt', _b.attempt_count);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_capability_batch(bigint, int, text) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_agent_capability_batch(bigint, int, text) TO authenticated;

-- Re-queue from dead letter
CREATE OR REPLACE FUNCTION public.requeue_dead_letter_batch(_dead_letter_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _dl record;
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT * INTO _dl FROM public.agent_capability_ops_dead_letters
   WHERE id = _dead_letter_id AND resolved_at IS NULL FOR UPDATE;
  IF _dl.id IS NULL THEN
    RAISE EXCEPTION 'Dead letter not found or already resolved';
  END IF;

  UPDATE public.agent_capability_ops_job_batches
     SET status = 'pending',
         attempt_count = 0,
         max_attempts = 5,
         next_attempt_at = now(),
         dead_lettered_at = NULL,
         finished_at = NULL,
         error = NULL,
         claimed_at = NULL
   WHERE id = _dl.batch_id;

  UPDATE public.agent_capability_ops_jobs
     SET status = 'running',
         finished_at = NULL,
         failed_total = GREATEST(failed_total - 1, 0)
   WHERE id = _dl.job_id;

  UPDATE public.agent_capability_ops_dead_letters
     SET resolved_at = now(), resolution = 'requeued'
   WHERE id = _dead_letter_id;
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_dead_letter_batch(bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.requeue_dead_letter_batch(bigint) TO authenticated;

-- Archive
CREATE OR REPLACE FUNCTION public.archive_dead_letter_batch(_dead_letter_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  UPDATE public.agent_capability_ops_dead_letters
     SET resolved_at = now(), resolution = 'archived'
   WHERE id = _dead_letter_id AND resolved_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_dead_letter_batch(bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.archive_dead_letter_batch(bigint) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_capability_ops_dead_letters;