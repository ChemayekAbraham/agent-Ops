-- lovable-cron-fallback-reviewed: deferrals expire after 30 minutes and the re-push must follow promptly, so a 5-minute sweep (288 runs/day) is the required cadence; cost explained to the user.
-- SRQ-GATE-01OCT-A: blocking approval prompt for ordinary staff requisitions
-- at the COO / CEO / CFO stages, named approvers only. Prompt bookkeeping only:
-- no wallet, ledger or credit logic, and no change to the decision path
-- (staff-requisition-decide remains the single decision path).

CREATE TABLE public.staff_requisition_prompt_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL CHECK (stage IN ('coo','ceo','cfo')),
  user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage, user_id)
);

GRANT SELECT ON public.staff_requisition_prompt_authorities TO authenticated;
GRANT ALL ON public.staff_requisition_prompt_authorities TO service_role;
ALTER TABLE public.staff_requisition_prompt_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin and HR read prompt authorities"
ON public.staff_requisition_prompt_authorities
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hr'));

INSERT INTO public.staff_requisition_prompt_authorities (stage, user_id, reason)
VALUES
  ('coo', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c', 'Named requisition prompt approver, instruction of HR Lead 2026-10-01'),
  ('ceo', 'cf561688-b3a2-4f62-b9c1-67ee7b36ff2b', 'Named requisition prompt approver, instruction of HR Lead 2026-10-01'),
  ('cfo', '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'Named requisition prompt approver, instruction of HR Lead 2026-10-01');

CREATE TABLE public.staff_requisition_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.staff_requisitions(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('coo','ceo','cfo')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','snoozed','resolved')),
  snooze_until timestamptz,
  snooze_count smallint NOT NULL DEFAULT 0,
  last_pushed_at timestamptz,
  push_count smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,
  UNIQUE (requisition_id, approver_id, stage)
);

GRANT SELECT ON public.staff_requisition_prompts TO authenticated;
GRANT ALL ON public.staff_requisition_prompts TO service_role;
ALTER TABLE public.staff_requisition_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Approvers read their own requisition prompts"
ON public.staff_requisition_prompts
FOR SELECT TO authenticated
USING (approver_id = auth.uid());

CREATE INDEX idx_srq_prompts_approver_state
  ON public.staff_requisition_prompts (approver_id, state);

-- Prompt fan-out. Never blocks a decision: the whole body is wrapped in an
-- exception handler that warns and returns NEW.
CREATE OR REPLACE FUNCTION public.tg_staff_requisition_prompt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entered boolean := false;
  v_inserted integer := 0;
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
      ON CONFLICT (requisition_id, approver_id, stage) DO NOTHING;

      GET DIAGNOSTICS v_inserted = ROW_COUNT;

      IF v_inserted = 0 THEN
        INSERT INTO public.staff_requisition_events (requisition_id, action, actor_name, stage, comment)
        VALUES (
          NEW.id, 'comment', 'System', NEW.stage,
          'No eligible named approver to prompt at ' || upper(NEW.stage) || ' stage.'
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_staff_requisition_prompt skipped for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END
$$;

CREATE TRIGGER tg_staff_requisition_prompt
AFTER INSERT OR UPDATE ON public.staff_requisitions
FOR EACH ROW EXECUTE FUNCTION public.tg_staff_requisition_prompt();

CREATE OR REPLACE FUNCTION public.staff_requisition_pending_prompt()
RETURNS TABLE (
  prompt_id uuid,
  stage text,
  requisition_id uuid,
  requisition_code text,
  requester_name text,
  department_key text,
  title text,
  reason text,
  amount numeric,
  approved_amount numeric,
  currency text,
  attachment_urls text[],
  raised_at timestamptz,
  coo_approver_name text,
  ceo_approver_name text,
  snooze_count smallint,
  total_pending bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (
    SELECT p.*
      FROM public.staff_requisition_prompts p
      JOIN public.staff_requisitions r ON r.id = p.requisition_id
     WHERE p.approver_id = auth.uid()
       AND p.state <> 'resolved'
       AND r.stage = p.stage
  )
  SELECT
    m.id,
    m.stage,
    r.id,
    r.requisition_code,
    coalesce(pr.full_name, r.requester_name),
    r.department_key,
    r.title,
    r.reason,
    r.amount,
    r.approved_amount,
    r.currency,
    r.attachment_urls,
    r.created_at,
    coo.full_name,
    ceo.full_name,
    m.snooze_count,
    (SELECT count(*) FROM mine)
  FROM mine m
  JOIN public.staff_requisitions r ON r.id = m.requisition_id
  LEFT JOIN public.profiles pr ON pr.id = r.requester_id
  LEFT JOIN public.profiles coo ON coo.id = r.coo_decided_by
  LEFT JOIN public.profiles ceo ON ceo.id = r.ceo_decided_by
 WHERE m.snooze_until IS NULL OR m.snooze_until <= now()
 ORDER BY m.created_at
 LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.staff_requisition_prompt_snooze()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_until timestamptz := now() + interval '30 minutes';
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
$$;

REVOKE ALL ON FUNCTION public.staff_requisition_pending_prompt() FROM public, anon;
REVOKE ALL ON FUNCTION public.staff_requisition_prompt_snooze() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_pending_prompt() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_requisition_prompt_snooze() TO authenticated;

-- Backfill: requisitions sitting at coo / ceo / cfo right now, same eligibility.
INSERT INTO public.staff_requisition_prompts (requisition_id, approver_id, stage)
SELECT r.id, a.user_id, r.stage
  FROM public.staff_requisitions r
  JOIN public.staff_requisition_prompt_authorities a ON a.stage = r.stage AND a.enabled
 WHERE coalesce(r.request_kind, 'requisition') = 'requisition'
   AND r.stage IN ('coo','ceo','cfo')
   AND public.has_role(a.user_id, r.stage::app_role)
   AND a.user_id <> r.requester_id
   AND a.user_id IS DISTINCT FROM r.supervisor_decided_by
   AND a.user_id IS DISTINCT FROM r.coo_decided_by
   AND a.user_id IS DISTINCT FROM r.ceo_decided_by
ON CONFLICT (requisition_id, approver_id, stage) DO NOTHING;

-- Every 5 minutes: re-push prompts whose deferral has expired.
SELECT cron.schedule(
  'requisition-approval-push-5min',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/requisition-approval-push',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $cron$
);
