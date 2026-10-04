
-- Recreate the missing system_events sink. Multiple triggers
-- (trg_log_ledger_wallet_transfer, on_rent_request_log_event,
--  trg_log_withdrawal_status, trg_log_deposit_status, trigger_log_user_created_event, etc.)
-- and RPCs insert here via log_system_event(). Without the table, every
-- state-changing transaction that emits an event (reject listing, create
-- funder account, post ledger, update withdrawal/deposit status, insert
-- user_roles) aborts with "relation public.system_events does not exist".
CREATE TABLE IF NOT EXISTS public.system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  user_id UUID NULL,
  related_entity_type TEXT NULL,
  related_entity_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON public.system_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_event_type_created ON public.system_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_user_id ON public.system_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_events_related ON public.system_events (related_entity_type, related_entity_id) WHERE related_entity_id IS NOT NULL;

-- Triggers run as SECURITY DEFINER via log_system_event; the function
-- inserts rows on behalf of the caller. Give service_role full access and
-- authenticated INSERT so trigger-based emissions from user-initiated
-- transactions can commit. Reads are restricted to staff via policy.
GRANT ALL ON public.system_events TO service_role;
GRANT INSERT ON public.system_events TO authenticated;
GRANT SELECT ON public.system_events TO authenticated;

ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can INSERT (needed because triggers fire under the
-- caller's role when SECURITY DEFINER is not explicit on trigger fns).
DROP POLICY IF EXISTS "system_events_insert_authenticated" ON public.system_events;
CREATE POLICY "system_events_insert_authenticated"
ON public.system_events FOR INSERT TO authenticated
WITH CHECK (true);

-- Reads restricted to staff (ops/admin). Regular users cannot browse.
DROP POLICY IF EXISTS "system_events_read_staff" ON public.system_events;
CREATE POLICY "system_events_read_staff"
ON public.system_events FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);
