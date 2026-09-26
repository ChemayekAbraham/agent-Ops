-- Tenant Ops Workspace — new parallel read-model tables.
--
-- Per docs/TOPS_RULES.md: additive only. This migration creates three NEW
-- tables and nothing else. No existing table, view, function, trigger,
-- index, policy, grant or cron job is touched, altered or replaced.
--
-- These are derived read-models. agent_collections remains the source of
-- truth for what a tenant actually paid; rent_requests remains the source
-- of truth for the plan itself. Classic does not read these tables and is
-- unaffected by their existence. Only a SECURITY DEFINER function (added in
-- a later task) will ever write to them — no client INSERT/UPDATE/DELETE
-- grant is given here.

-- ---------------------------------------------------------------------------
-- 1. tops_plan_clock — our own reading of when a plan's repayment clock
--    actually started and how it repeats, kept alongside (not instead of)
--    rent_requests.repayment_starts_on / repayment_frequency.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_plan_clock (
  rent_request_id uuid PRIMARY KEY REFERENCES public.rent_requests(id),
  clock_start date NOT NULL,
  clock_source text NOT NULL CHECK (clock_source IN ('landlord_receipt', 'funded_at', 'override')),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'unknown')),
  cadence_source text NOT NULL CHECK (cadence_source IN ('explicit', 'unknown')),
  weekly_due_dow smallint CHECK (weekly_due_dow BETWEEN 0 AND 6),
  override_reason text,
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tops_plan_clock IS
'Derived read-model: our own reading of when a plan''s repayment clock started (clock_source) and its cadence (cadence_source), one row per plan. agent_collections and rent_requests remain the source of truth; this table only records our own derived/overridden reading alongside them. Classic does not read this table.';

REVOKE ALL ON public.tops_plan_clock FROM PUBLIC;
GRANT SELECT ON public.tops_plan_clock TO authenticated;
ALTER TABLE public.tops_plan_clock ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_plan_clock_select_tops_roles ON public.tops_plan_clock
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ---------------------------------------------------------------------------
-- 2. tops_plan_instalments — our own instalment schedule, one row per due
--    date, derived from tops_plan_clock rather than the funding date.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_plan_instalments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  seq integer NOT NULL,
  due_date date NOT NULL,
  amount_ugx numeric(14, 2) NOT NULL CHECK (amount_ugx >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rent_request_id, seq)
);

CREATE INDEX tops_plan_instalments_due_date_idx ON public.tops_plan_instalments (due_date);
CREATE INDEX tops_plan_instalments_rent_request_due_date_idx ON public.tops_plan_instalments (rent_request_id, due_date);

COMMENT ON TABLE public.tops_plan_instalments IS
'Derived read-model: our own instalment schedule for a plan, one row per due date, priced and dated from tops_plan_clock. rent_requests and agent_collections remain the source of truth for the plan and its payments; this table never writes to either. Classic does not read this table.';

REVOKE ALL ON public.tops_plan_instalments FROM PUBLIC;
GRANT SELECT ON public.tops_plan_instalments TO authenticated;
ALTER TABLE public.tops_plan_instalments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_plan_instalments_select_tops_roles ON public.tops_plan_instalments
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ---------------------------------------------------------------------------
-- 3. tops_instalment_settlements — our own attribution of an agent_collections
--    row to one of our instalments. collection_id deliberately carries no
--    foreign key: we never constrain a table we do not own.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_instalment_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instalment_id uuid NOT NULL REFERENCES public.tops_plan_instalments(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  amount_ugx numeric(14, 2) NOT NULL CHECK (amount_ugx > 0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (instalment_id, collection_id)
);

CREATE INDEX tops_instalment_settlements_collection_id_idx ON public.tops_instalment_settlements (collection_id);
CREATE INDEX tops_instalment_settlements_rent_request_id_idx ON public.tops_instalment_settlements (rent_request_id);

COMMENT ON TABLE public.tops_instalment_settlements IS
'Derived read-model: our own attribution of an agent_collections row (collection_id, deliberately no foreign key — we never constrain a table we do not own) to one of our tops_plan_instalments rows. released_at is set when the source collection is reversed. agent_collections remains the source of truth for the payment itself; this table never writes to it. Classic does not read this table.';

REVOKE ALL ON public.tops_instalment_settlements FROM PUBLIC;
GRANT SELECT ON public.tops_instalment_settlements TO authenticated;
ALTER TABLE public.tops_instalment_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_instalment_settlements_select_tops_roles ON public.tops_instalment_settlements
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );
