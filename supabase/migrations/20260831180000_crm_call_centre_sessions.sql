-- CRM Call Centre — telephony session records for Africa's Talking Voice.
--
-- Until now every "Call" affordance in the app was a `tel:` link, which dials
-- from the staff member's own handset and leaves no record. This table is the
-- server-side record of calls placed THROUGH the platform via the Africa's
-- Talking Voice API, using the agent-leg-first bridge:
--
--   1. `crm-place-call` asks AT to ring the CRM staff member's own phone.
--   2. When they answer, AT posts to `crm-voice-callback`, which returns
--      <Dial> XML bridging the leg to the customer.
--   3. Terminal callbacks land back on the same row with duration, cost,
--      recording URL and hangup cause.
--
-- Scope boundary: this table is the TELEPHONY record only. Call *outcomes* for
-- tenants and landlords continue to live in `tenant_call_reports` /
-- `landlord_call_reports` and their Calling Hubs — this migration deliberately
-- does not duplicate that. `disposition`/`notes` here exist so a call to a
-- supporter or an arbitrary number (which has no call-reports table) is still
-- accountable.

CREATE TABLE public.crm_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Africa's Talking sessionId. Null until the /call POST returns, and the join
  -- key for every subsequent voice callback.
  at_session_id text UNIQUE,

  -- Who placed the call, and the number AT rings first.
  staff_id uuid NOT NULL,
  staff_phone text NOT NULL,

  -- Who was called. `target_user_id` is null for a free-typed number.
  target_user_id uuid,
  target_role text,
  target_name text,
  target_phone text NOT NULL,

  status text NOT NULL DEFAULT 'initiating'
    CHECK (status IN (
      'initiating',    -- row written, AT not yet called
      'queued',        -- AT accepted the request
      'ringing_staff', -- staff leg answered, about to bridge
      'bridged',       -- <Dial> issued toward the customer
      'completed',     -- terminal callback, call had a duration
      'no_answer',     -- terminal callback, never connected
      'failed'         -- AT rejected, or we could not reach AT
    )),

  -- Raw AT reporting, kept verbatim for diagnostics.
  at_call_status text,
  hangup_cause text,
  duration_seconds integer,
  recording_url text,
  cost_amount numeric,
  cost_currency text,
  failure_reason text,

  -- Staff-editable follow-up (column-level grant below).
  disposition text,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_crm_call_sessions_staff ON public.crm_call_sessions (staff_id, created_at DESC);
CREATE INDEX idx_crm_call_sessions_target ON public.crm_call_sessions (target_user_id, created_at DESC);
CREATE INDEX idx_crm_call_sessions_created ON public.crm_call_sessions (created_at DESC);
-- The voice callback falls back to "most recent live leg for this number" when
-- AT sends a callback we cannot match on sessionId.
CREATE INDEX idx_crm_call_sessions_staff_phone_live ON public.crm_call_sessions (staff_phone, created_at DESC)
  WHERE status IN ('initiating', 'queued', 'ringing_staff');

ALTER TABLE public.crm_call_sessions ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.crm_call_sessions TO authenticated;
-- Staff may annotate a call, never rewrite its telephony facts.
GRANT UPDATE (disposition, notes) ON public.crm_call_sessions TO authenticated;
GRANT ALL ON public.crm_call_sessions TO service_role;

-- Reader set: the CRM function plus the four ops departments.
--
-- NOTE: `is_ops_role()` covers only manager/super_admin/coo/operations — it does
-- NOT include the dedicated `agent_ops` / `tenant_ops` / `landlord_ops` /
-- `partner_ops` roles, which 41 staff actually hold in production. They are
-- therefore listed explicitly; relying on is_ops_role() alone would lock out
-- exactly the people this screen is for. `has_role()` filters `enabled = true`,
-- so a revoked role stops granting access.
CREATE POLICY "Call centre staff read call sessions" ON public.crm_call_sessions
FOR SELECT TO authenticated
USING (
  public.is_ops_role((SELECT auth.uid()))
  OR public.has_role((SELECT auth.uid()), 'crm')
  OR public.has_role((SELECT auth.uid()), 'manager')
  OR public.has_role((SELECT auth.uid()), 'super_admin')
  OR public.has_role((SELECT auth.uid()), 'coo')
  OR public.has_role((SELECT auth.uid()), 'ceo')
  OR public.has_role((SELECT auth.uid()), 'cto')
  OR public.has_role((SELECT auth.uid()), 'agent_ops')
  OR public.has_role((SELECT auth.uid()), 'tenant_ops')
  OR public.has_role((SELECT auth.uid()), 'landlord_ops')
  OR public.has_role((SELECT auth.uid()), 'partner_ops')
);

-- Annotation is limited to the person who placed the call. Combined with the
-- column-level GRANT above, this cannot touch duration, cost or status.
CREATE POLICY "Caller annotates own call session" ON public.crm_call_sessions
FOR UPDATE TO authenticated
USING (staff_id = (SELECT auth.uid()))
WITH CHECK (staff_id = (SELECT auth.uid()));

-- No INSERT policy: rows are created only by `crm-place-call` under the service
-- role, so a client can never fabricate a call record.

CREATE OR REPLACE FUNCTION public.touch_crm_call_sessions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_crm_call_sessions_updated_at
BEFORE UPDATE ON public.crm_call_sessions
FOR EACH ROW EXECUTE FUNCTION public.touch_crm_call_sessions_updated_at();

-- Per-staff daily rollup for the Call Centre header strip.
CREATE VIEW public.v_crm_call_activity
WITH (security_invoker = true) AS
SELECT s.staff_id,
       date_trunc('day', s.created_at) AS call_day,
       count(*)::int AS calls_placed,
       count(*) FILTER (WHERE s.status = 'completed')::int AS calls_connected,
       count(*) FILTER (WHERE s.status IN ('no_answer', 'failed'))::int AS calls_unreached,
       COALESCE(sum(s.duration_seconds), 0)::int AS total_seconds,
       COALESCE(sum(s.cost_amount), 0) AS total_cost
FROM public.crm_call_sessions s
GROUP BY s.staff_id, date_trunc('day', s.created_at);

GRANT SELECT ON public.v_crm_call_activity TO authenticated;
GRANT SELECT ON public.v_crm_call_activity TO service_role;
