ALTER TABLE public.tenant_call_reports
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;

UPDATE public.tenant_call_reports
SET status = CASE WHEN outcome = 'picked_up' THEN 'pending' ELSE 'missed' END
WHERE status IS NULL;

ALTER TABLE public.tenant_call_reports
  ALTER COLUMN status SET DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_call_reports_status_check'
  ) THEN
    ALTER TABLE public.tenant_call_reports
      ADD CONSTRAINT tenant_call_reports_status_check
      CHECK (status IN ('pending', 'closed', 'missed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_call_reports_status_called_at
  ON public.tenant_call_reports (status, called_at DESC);

CREATE OR REPLACE VIEW public.v_tenant_call_summary AS
 SELECT tenant_id,
    count(*)::integer AS call_count,
    count(*) FILTER (WHERE outcome = 'picked_up'::text)::integer AS picked_up_count,
    count(*) FILTER (WHERE outcome = 'missed'::text)::integer AS missed_count,
    max(called_at) AS last_call_at,
    max(called_at) FILTER (WHERE outcome = 'picked_up'::text) AS last_picked_up_at,
    (array_agg(outcome ORDER BY called_at DESC))[1] AS last_outcome,
    (array_agg(comment ORDER BY called_at DESC) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> ''::text))[1] AS latest_comment,
    (array_agg(called_at ORDER BY called_at DESC) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> ''::text))[1] AS latest_comment_at,
    (array_agg(status ORDER BY called_at DESC))[1] AS last_status,
    count(*) FILTER (WHERE status = 'pending'::text)::integer AS pending_count,
    count(*) FILTER (WHERE status = 'closed'::text)::integer AS closed_count,
    (array_agg(follow_up_at ORDER BY called_at DESC) FILTER (WHERE follow_up_at IS NOT NULL))[1] AS last_follow_up_at
   FROM tenant_call_reports c
  GROUP BY tenant_id;