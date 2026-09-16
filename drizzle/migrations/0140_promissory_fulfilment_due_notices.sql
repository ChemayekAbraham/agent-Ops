-- Fulfilment-day reminder queue for promissory notes.
-- Nothing is sent directly at note creation/edit: a daily job queues a notice
-- for each unfulfilled note whose promised fulfilment day is today, for both
-- the proxy agent and the partner, and a worker drains the queue.
CREATE TABLE IF NOT EXISTS public.promissory_note_fulfilment_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES public.promissory_notes(id) ON DELETE CASCADE,
  due_on date NOT NULL,
  recipient_role text NOT NULL CHECK (recipient_role IN ('agent','partner')),
  recipient_user_id uuid,
  recipient_name text,
  phone text,
  partner_name text,
  agent_name text,
  amount numeric,
  outstanding numeric,
  sms_status text NOT NULL DEFAULT 'pending' CHECK (sms_status IN ('pending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promissory_fulfilment_notice_once
  ON public.promissory_note_fulfilment_notices (note_id, due_on, recipient_role);
CREATE INDEX IF NOT EXISTS promissory_fulfilment_notice_pending
  ON public.promissory_note_fulfilment_notices (sms_status, created_at);

GRANT ALL ON public.promissory_note_fulfilment_notices TO service_role;

ALTER TABLE public.promissory_note_fulfilment_notices ENABLE ROW LEVEL SECURITY;

-- Operational queue: only the service role (edge worker) touches it. No
-- policies for anon/authenticated by design.

CREATE OR REPLACE FUNCTION public.psm_queue_promissory_fulfilment_notices(
  p_run_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala')::date)
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queued integer := 0;
BEGIN
  WITH due AS (
    SELECT n.id,
           n.agent_id,
           n.fulfilment_due_on,
           n.partner_name,
           n.partner_user_id,
           COALESCE(NULLIF(btrim(n.phone_number), ''), NULLIF(btrim(n.whatsapp_number), '')) AS partner_phone,
           COALESCE(n.amount, 0) AS amount,
           GREATEST(COALESCE(n.amount, 0) - COALESCE(n.total_collected, 0), 0) AS outstanding,
           ap.full_name AS agent_name,
           ap.phone AS agent_phone,
           pp.full_name AS partner_profile_name,
           pp.phone AS partner_profile_phone
    FROM public.promissory_notes n
    LEFT JOIN public.profiles ap ON ap.id = n.agent_id
    LEFT JOIN public.profiles pp ON pp.id = n.partner_user_id
    WHERE n.fulfilment_due_on = p_run_date
      AND n.status = 'pending'
  ), ins AS (
    INSERT INTO public.promissory_note_fulfilment_notices (
      note_id, due_on, recipient_role, recipient_user_id, recipient_name,
      phone, partner_name, agent_name, amount, outstanding
    )
    SELECT d.id, d.fulfilment_due_on, r.role,
           CASE WHEN r.role = 'agent' THEN d.agent_id ELSE d.partner_user_id END,
           CASE WHEN r.role = 'agent' THEN d.agent_name
                ELSE COALESCE(d.partner_profile_name, d.partner_name) END,
           CASE WHEN r.role = 'agent' THEN d.agent_phone
                ELSE COALESCE(d.partner_phone, d.partner_profile_phone) END,
           d.partner_name, d.agent_name, d.amount, d.outstanding
    FROM due d
    CROSS JOIN (VALUES ('agent'), ('partner')) AS r(role)
    ON CONFLICT (note_id, due_on, recipient_role) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_queued FROM ins;

  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.psm_queue_promissory_fulfilment_notices(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.psm_queue_promissory_fulfilment_notices(date) TO service_role;