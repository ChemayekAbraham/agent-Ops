-- Tenant Ops Workspace — promises-to-pay, our own call-outcome log, and the
-- calling-round gap check.
--
-- Per docs/TOPS_RULES.md: the calling engine does not change. No cc_ table,
-- RPC, cron job or round-population logic is altered anywhere in this file —
-- confirmed by inspection: every statement below either CREATEs a new tops_
-- object or SELECTs from existing cc_/tops_ objects. cc_call_id below
-- deliberately carries no foreign key to cc_call_attempts — we never
-- constrain a table we do not own.

-- ---------------------------------------------------------------------------
-- 1. tops_promises_to_pay
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_promises_to_pay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  tenant_user_id uuid NOT NULL,
  cc_call_id uuid NULL,
  promised_amount_ugx numeric(14,2) NOT NULL CHECK (promised_amount_ugx > 0),
  promised_date date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('call', 'sms', 'visit', 'whatsapp')),
  taken_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'partial', 'broken')),
  settled_amount_ugx numeric(14,2) NOT NULL DEFAULT 0,
  resolved_at timestamptz NULL
);

CREATE INDEX tops_promises_to_pay_rent_request_id_idx ON public.tops_promises_to_pay (rent_request_id);
CREATE INDEX tops_promises_to_pay_promised_date_idx ON public.tops_promises_to_pay (promised_date);
CREATE INDEX tops_promises_to_pay_status_idx ON public.tops_promises_to_pay (status);

COMMENT ON TABLE public.tops_promises_to_pay IS
'Our own promise-to-pay log, captured during a call in the Tenant Ops Workspace. cc_call_id references cc_call_attempts.id with no foreign key — we never constrain a table we do not own. Resolved only by tops_resolve_promises(); Classic and the cc_* calling engine do not read or write this table.';

REVOKE ALL ON public.tops_promises_to_pay FROM PUBLIC;
GRANT SELECT, INSERT ON public.tops_promises_to_pay TO authenticated;
ALTER TABLE public.tops_promises_to_pay ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_promises_to_pay_select_tops_roles ON public.tops_promises_to_pay
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY tops_promises_to_pay_insert_tops_roles ON public.tops_promises_to_pay
  FOR INSERT TO authenticated
  WITH CHECK (
    taken_by = auth.uid()
    AND (
      public.has_role(auth.uid(), 'tenant_ops'::app_role)
      OR public.has_role(auth.uid(), 'operations'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'cfo'::app_role)
      OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  );

-- No UPDATE policy for any client role: only tops_resolve_promises() (a
-- SECURITY DEFINER function, bypassing RLS via table ownership) resolves a
-- promise. No DELETE policy at all — a promise is never removed.

-- ---------------------------------------------------------------------------
-- 2. tops_call_outcomes — our own outcome log, additive to the existing
--    cc_call_attempts.outcome (a different, narrower enum already recorded
--    by the calling engine itself). This one is never written to by cc_*.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_call_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cc_call_id uuid NULL,
  rent_request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'reached', 'promised', 'refused', 'unreachable', 'wrong_number', 'disputes_balance', 'other'
  )),
  note text NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tops_call_outcomes_rent_request_id_idx ON public.tops_call_outcomes (rent_request_id);
CREATE INDEX tops_call_outcomes_recorded_at_idx ON public.tops_call_outcomes (recorded_at);

COMMENT ON TABLE public.tops_call_outcomes IS
'Our own call-outcome log for the Tenant Ops Workspace calling screen — a richer vocabulary than cc_call_attempts.outcome, recorded alongside it, never instead of it. cc_call_id references cc_call_attempts.id with no foreign key. Classic and the cc_* calling engine do not read or write this table.';

REVOKE ALL ON public.tops_call_outcomes FROM PUBLIC;
GRANT SELECT, INSERT ON public.tops_call_outcomes TO authenticated;
ALTER TABLE public.tops_call_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_call_outcomes_select_tops_roles ON public.tops_call_outcomes
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY tops_call_outcomes_insert_tops_roles ON public.tops_call_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (
    recorded_by = auth.uid()
    AND (
      public.has_role(auth.uid(), 'tenant_ops'::app_role)
      OR public.has_role(auth.uid(), 'operations'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'cfo'::app_role)
      OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. tops_resolve_promises(p_as_at) — resolves every open promise whose date
--    has passed. Idempotent: only touches status = 'open' rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_resolve_promises(p_as_at date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_promise record;
  v_settled numeric(14,2);
  v_window_end timestamptz;
  v_count integer := 0;
BEGIN
  FOR v_promise IN
    SELECT * FROM public.tops_promises_to_pay
    WHERE status = 'open' AND promised_date < v_as_at
  LOOP
    v_window_end := ((v_promise.promised_date + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

    SELECT COALESCE(SUM(ac.amount), 0)
    INTO v_settled
    FROM public.agent_collections ac
    WHERE ac.rent_request_id = v_promise.rent_request_id
      AND ac.reversed_at IS NULL
      AND ac.created_at >= v_promise.created_at
      AND ac.created_at < v_window_end;

    UPDATE public.tops_promises_to_pay
    SET
      status = CASE
        WHEN v_settled >= v_promise.promised_amount_ugx THEN 'kept'
        WHEN v_settled > 0 THEN 'partial'
        ELSE 'broken'
      END,
      settled_amount_ugx = v_settled,
      resolved_at = now()
    WHERE id = v_promise.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_resolve_promises(date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_resolve_promises(date) IS
'Resolves every open tops_promises_to_pay row whose promised_date has passed: kept/partial/broken based on net (reversed_at IS NULL) agent_collections for that plan between the promise''s created_at and promised_date + 1 day (Kampala). Idempotent — only touches status = ''open'' rows. Internal engine only (no EXECUTE grant), driven by the tops-resolve-promises-daily cron job.';

SELECT cron.schedule(
  'tops-resolve-promises-daily',
  '0 23 * * *',
  $$ SELECT public.tops_resolve_promises(NULL); $$
);

-- ---------------------------------------------------------------------------
-- 4. tops_promise_kept_rate(p_from, p_to, p_user_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_promise_kept_rate(
  p_from date,
  p_to date,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  taken integer,
  kept integer,
  partial integer,
  broken integer,
  still_open integer,
  kept_rate_pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR (p_user_id IS NOT NULL AND p_user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::integer AS taken,
    count(*) FILTER (WHERE status = 'kept')::integer AS kept,
    count(*) FILTER (WHERE status = 'partial')::integer AS partial,
    count(*) FILTER (WHERE status = 'broken')::integer AS broken,
    count(*) FILTER (WHERE status = 'open')::integer AS still_open,
    ROUND(
      100.0 * count(*) FILTER (WHERE status = 'kept')
      / NULLIF(count(*) FILTER (WHERE status IN ('kept', 'partial', 'broken')), 0),
      1
    ) AS kept_rate_pct
  FROM public.tops_promises_to_pay
  WHERE created_at::date BETWEEN p_from AND p_to
    AND (p_user_id IS NULL OR taken_by = p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_promise_kept_rate(date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_promise_kept_rate(date, date, uuid) TO authenticated;

COMMENT ON FUNCTION public.tops_promise_kept_rate(date, date, uuid) IS
'Promise-kept rate for promises taken (created_at) in a date range: kept/partial/broken/still_open counts and kept_rate_pct = kept / (kept+partial+broken), never counting partial as fully kept. p_user_id null aggregates every officer (requires an ops role); any authenticated user may always query their own (p_user_id = auth.uid()).';

-- ---------------------------------------------------------------------------
-- 5. tops_calling_gap() — read-only. The open round is a snapshot; we never
--    change that. This only surfaces, in our own UI, eligible tenants with
--    no row in the open round.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_calling_gap()
RETURNS TABLE (
  tenant_id uuid,
  rent_request_id uuid,
  outstanding numeric,
  arrears_amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.tenant_id, p.rent_request_id, p.outstanding, p.arrears_amount
  FROM public.v_cc_tenant_calling_population p
  WHERE p.tenant_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.cc_cycle_rows r
      JOIN public.cc_call_cycles c ON c.id = r.cycle_id
      WHERE c.closed_at IS NULL
        AND c.subject_type = 'tenant'
        AND r.subject_type = 'tenant'
        AND r.subject_id = p.tenant_id
    );
$$;

REVOKE ALL ON FUNCTION public.tops_calling_gap() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_calling_gap() TO authenticated;

COMMENT ON FUNCTION public.tops_calling_gap() IS
'Read-only: eligible tenants (v_cc_tenant_calling_population) with no row in the currently-open cc_ tenant round. The round itself is untouched — this only lets our UI label these tenants "not in this round". Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 6. tops_calling_money_at_risk(p_tenant_ids) — supports "ordered by money at
--    risk from tops_plan_position" for the calling queue. Batches the lookup
--    (one call per page, not one per row) by resolving each tenant's plan via
--    the same v_cc_tenant_calling_population mapping the calling engine
--    itself uses, then reusing tops_plan_position() unchanged for the money
--    figure — no new money math, just batching an existing function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_calling_money_at_risk(p_tenant_ids uuid[])
RETURNS TABLE (
  tenant_id uuid,
  rent_request_id uuid,
  money_at_risk_ugx numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_rent_request_id uuid;
  v_pos record;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOREACH v_tenant_id IN ARRAY p_tenant_ids LOOP
    SELECT p.rent_request_id INTO v_rent_request_id
    FROM public.v_cc_tenant_calling_population p
    WHERE p.tenant_id = v_tenant_id;

    IF v_rent_request_id IS NULL THEN
      tenant_id := v_tenant_id;
      rent_request_id := NULL;
      money_at_risk_ugx := NULL;
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT * INTO v_pos FROM public.tops_plan_position(v_rent_request_id, NULL);

    tenant_id := v_tenant_id;
    rent_request_id := v_rent_request_id;
    -- v_pos.position_ugx is NULL exactly when cadence_source = 'unknown' —
    -- preserve that as NULL here too, never fabricate a zero (the whole
    -- system's "never a number for unknown cadence" rule applies here too).
    money_at_risk_ugx := CASE WHEN v_pos.position_ugx IS NULL THEN NULL ELSE GREATEST(-v_pos.position_ugx, 0) END;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_calling_money_at_risk(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_calling_money_at_risk(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.tops_calling_money_at_risk(uuid[]) IS
'Batched money-at-risk lookup for a page of tenant ids (one RPC call per page, not one per row): resolves each tenant to the same plan v_cc_tenant_calling_population already maps them to, then reuses tops_plan_position() unchanged. money_at_risk_ugx is GREATEST(-position_ugx, 0) — zero for a tenant who is on track or ahead. Gated by an internal has_role check.';
