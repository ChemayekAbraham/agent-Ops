-- Tenant Ops Calling Center — 30M (UGX 30 Million) Rent Plan awareness tracking.
--
-- Additive and isolated: follows the same pattern as tops_call_outcomes.
--  - No cc_* table, RPC, trigger, or calling engine object is touched.
--  - cc_call_id references cc_call_attempts.id with no foreign key (we never
--    constrain a table we do not own).
--  - The calling and hang-up path is completely unchanged.
--  - This table is never read or written by the cc_* spine.

-- ---------------------------------------------------------------------------
-- 1. tops_30m_awareness — one row per answered call where the officer captured
--    the four awareness questions. All four questions must be answered together
--    as a single atomic insert (no partial rows).
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_30m_awareness (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Soft-reference to the cc_call_attempts row (no FK — we do not own cc_*).
  cc_call_id          uuid        NULL,
  -- The tenant who was on the call.
  tenant_user_id      uuid        NOT NULL,
  -- The logged-in officer who captured the awareness.
  recorded_by         uuid        NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),

  -- Q1: Awareness before the explanation.
  awareness_before    text        NOT NULL CHECK (awareness_before IN (
                                    'knew',        -- Knew about it
                                    'heard',       -- Had heard about it but unsure
                                    'did_not_know' -- Did not know
                                  )),

  -- Q2: Was the 30M feature explained during this call?
  explanation_given   text        NOT NULL CHECK (explanation_given IN (
                                    'yes',    -- Yes
                                    'partly', -- Partly
                                    'no'      -- No
                                  )),

  -- Q3: Tenant's understanding after the explanation.
  understanding_after text        NOT NULL CHECK (understanding_after IN (
                                    'understood',        -- Understood
                                    'partly_understood', -- Partly understood
                                    'did_not_understand' -- Did not understand
                                  )),

  -- Q4: Tenant's interest / application intent.
  interest            text        NOT NULL CHECK (interest IN (
                                    'apply_now',        -- Wants to apply now
                                    'interested_later', -- Interested later
                                    'not_interested',   -- Not interested
                                    'not_sure'          -- Not sure
                                  )),

  -- Tenant's actual Rent Plan limit at the time of the call (UGX).
  -- NULL if the limit could not be resolved at call time (tenant not yet in
  -- credit_access_limits). Stored here so future limit changes do not
  -- alter historical awareness records.
  rent_plan_limit_ugx numeric(14,2) NULL
);

CREATE INDEX tops_30m_awareness_tenant_user_id_idx   ON public.tops_30m_awareness (tenant_user_id);
CREATE INDEX tops_30m_awareness_recorded_by_idx      ON public.tops_30m_awareness (recorded_by);
CREATE INDEX tops_30m_awareness_recorded_at_idx      ON public.tops_30m_awareness (recorded_at);
CREATE INDEX tops_30m_awareness_cc_call_id_idx       ON public.tops_30m_awareness (cc_call_id)
  WHERE cc_call_id IS NOT NULL;

COMMENT ON TABLE public.tops_30m_awareness IS
'Structured UGX 30M Rent Plan awareness tracking captured during answered Calling Center calls. '
'One row per call where all four questions were answered. cc_call_id soft-references '
'cc_call_attempts.id with no foreign key. The cc_* calling engine does not read or write this table. '
'The calling and hang-up path is completely unchanged — this is a purely additive overlay.';

-- ---------------------------------------------------------------------------
-- 2. RLS — same role set as every other tops_* table.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.tops_30m_awareness FROM PUBLIC;
GRANT SELECT, INSERT ON public.tops_30m_awareness TO authenticated;
ALTER TABLE public.tops_30m_awareness ENABLE ROW LEVEL SECURITY;

-- Officers may read all awareness rows (aggregate reporting).
CREATE POLICY tops_30m_awareness_select ON public.tops_30m_awareness
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- Officers may only insert rows they themselves recorded.
-- No UPDATE or DELETE — awareness records are permanent once captured.
CREATE POLICY tops_30m_awareness_insert ON public.tops_30m_awareness
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
-- 3. tops_30m_awareness_stats(p_from, p_to) — aggregate report function for
--    the weekly forwarding report. Read-only. Returns one row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_30m_awareness_stats(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  total_reached                    integer,
  awareness_knew                   integer,
  awareness_heard                  integer,
  awareness_did_not_know           integer,
  explanation_yes                  integer,
  explanation_partly               integer,
  explanation_no                   integer,
  understanding_understood         integer,
  understanding_partly             integer,
  understanding_did_not_understand integer,
  interest_apply_now               integer,
  interest_later                   integer,
  interest_not_interested          integer,
  interest_not_sure                integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::integer                                                           AS total_reached,
    count(*) FILTER (WHERE awareness_before = 'knew')::integer                 AS awareness_knew,
    count(*) FILTER (WHERE awareness_before = 'heard')::integer                AS awareness_heard,
    count(*) FILTER (WHERE awareness_before = 'did_not_know')::integer         AS awareness_did_not_know,
    count(*) FILTER (WHERE explanation_given = 'yes')::integer                 AS explanation_yes,
    count(*) FILTER (WHERE explanation_given = 'partly')::integer              AS explanation_partly,
    count(*) FILTER (WHERE explanation_given = 'no')::integer                  AS explanation_no,
    count(*) FILTER (WHERE understanding_after = 'understood')::integer        AS understanding_understood,
    count(*) FILTER (WHERE understanding_after = 'partly_understood')::integer AS understanding_partly,
    count(*) FILTER (WHERE understanding_after = 'did_not_understand')::integer AS understanding_did_not_understand,
    count(*) FILTER (WHERE interest = 'apply_now')::integer                    AS interest_apply_now,
    count(*) FILTER (WHERE interest = 'interested_later')::integer             AS interest_later,
    count(*) FILTER (WHERE interest = 'not_interested')::integer               AS interest_not_interested,
    count(*) FILTER (WHERE interest = 'not_sure')::integer                     AS interest_not_sure
  FROM public.tops_30m_awareness
  WHERE recorded_at >= p_from
    AND recorded_at <  p_to;
$$;

REVOKE ALL ON FUNCTION public.tops_30m_awareness_stats(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_30m_awareness_stats(timestamptz, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.tops_30m_awareness_stats(timestamptz, timestamptz) IS
'Aggregate 30M awareness stats for a time window (p_from inclusive, p_to exclusive). '
'Returns one row with counts by question option. Used by the Weekly Forwarding Report. '
'Read-only; the calling engine does not call this function.';
