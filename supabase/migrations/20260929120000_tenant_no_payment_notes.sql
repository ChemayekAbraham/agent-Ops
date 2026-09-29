-- Append-only Notes/Activity log for Classic Tenant Ops -> Weekly Performance ->
-- "20+ Days No Payment" tab. Purely additive: new table + new view only, no
-- existing object touched. Access mirrors the exact role check already used by
-- get_tenant_ops_no_payment_report() (the RPC that already gates this tab's
-- data), not a broadened or invented permission set.

CREATE TABLE public.tenant_no_payment_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  note text NOT NULL,
  note_type text NOT NULL DEFAULT 'general'
    CHECK (note_type IN ('general','call_answered','call_no_answer','sms_sent','promise_to_pay','payment_received','visit','escalation')),
  follow_up_date date,
  follow_up_status text CHECK (follow_up_status IN ('pending','done','not_required')),
  related_action text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_no_payment_notes_tenant_idx ON public.tenant_no_payment_notes (tenant_id, created_at DESC);

ALTER TABLE public.tenant_no_payment_notes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.tenant_no_payment_notes TO authenticated;
GRANT ALL ON public.tenant_no_payment_notes TO service_role;

CREATE POLICY "Tenant ops read no-payment notes" ON public.tenant_no_payment_notes
FOR SELECT TO authenticated USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'cfo')
);

CREATE POLICY "Tenant ops log no-payment notes" ON public.tenant_no_payment_notes
FOR INSERT TO authenticated WITH CHECK (
  created_by = auth.uid() AND (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'cfo')
  )
);

-- No UPDATE/DELETE policy anywhere: append-only at the database level, not
-- just a UI convention. Note content can never be overwritten.

-- Cheap "most recent note per tenant" for the list view, same pattern as the
-- existing v_tenant_call_summary (security_invoker inherits the caller's own
-- RLS-checked read access -- no separate grant needed).
CREATE VIEW public.v_tenant_no_payment_notes_summary
WITH (security_invoker = true) AS
SELECT
  tenant_id,
  count(*)::int AS notes_count,
  (array_agg(note ORDER BY created_at DESC))[1] AS last_note,
  (array_agg(note_type ORDER BY created_at DESC))[1] AS last_note_type,
  (array_agg(created_by ORDER BY created_at DESC))[1] AS last_created_by,
  max(created_at) AS last_note_at
FROM public.tenant_no_payment_notes
GROUP BY tenant_id;
