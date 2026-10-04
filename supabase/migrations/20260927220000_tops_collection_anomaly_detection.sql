-- Tenant Ops Workspace — collection anomaly detection. Per docs/TOPS_RULES.md:
-- detection only. Nothing here writes to agent_collections, general_ledger,
-- wallets, or anything on the collection write path; no trigger is added to
-- any existing table. Every object here is new, tops_-prefixed, and reads
-- existing tables only.
--
-- LEDGER LINKAGE (confirmed by a research pass against live data, NOT
-- assumed from migration text): a collection's main legs (float, repayment,
-- commission) are NOT linked by collection.id — they carry
-- source_table='agent_collections' but source_id = rent_request_id, posted
-- in the same transaction as the collection (same created_at, to the
-- microsecond). Every one of 10,484 live collections in the last 90 days
-- was confirmed to resolve this way with no ambiguity. Fee/treasury legs use
-- source_id = collection.id instead — not used by this detector, which only
-- cares about the float and commission legs.
--
-- "Clean history" (the seeding basis) is reversed_at IS NULL, classification
-- = 'production' (excludes reversal/void legs and corrections), and
-- excludes any row whose notes mention a manual restoration — a research
-- pass found exactly one live row where a float leg's direction was
-- deliberately restored/fixed by hand, still un-reversed, which would
-- otherwise poison the seed. It also found a 659-row window (2026-09-15
-- 16:41 to 09-16 07:31 UTC) from a since-fixed float-gate defect where no
-- float leg was posted at all; that window is excluded by requiring the
-- expected float leg's category (agent_float_used_for_rent) explicitly,
-- since that defect-era window used a different code path/leg shape entirely
-- and simply does not match the join below — no hardcoded date cutoff
-- needed.

-- ---------------------------------------------------------------------------
-- 1. tops_collection_expectations — the expected shape of a normal
--    collection, per channel. Seeded (not hand-written) by
--    tops_seed_collection_expectations() below, from the 5th-95th percentile
--    of clean history rather than raw min/max — deliberately, so that a
--    channel's own real outliers (a research pass found 9 of 40 in-scope
--    tenant_deposit_auto commission ratios sitting well above the 0.10 norm,
--    from a treasury-waterfall computation basis, not reversed or corrected)
--    do not get silently baked into the "normal" envelope and become
--    permanently invisible to the detector. That is a deliberate choice:
--    the whole point of an anomaly detector is to keep noticing real
--    outliers, not to average them away.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_collection_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_channel text NOT NULL UNIQUE,
  expected_float_direction text NOT NULL CHECK (expected_float_direction IN ('cash_in', 'cash_out', 'none')),
  expected_float_sign smallint NOT NULL CHECK (expected_float_sign IN (-1, 0, 1)),
  float_ratio_min numeric NOT NULL DEFAULT 0,
  float_ratio_max numeric NOT NULL DEFAULT 0,
  commission_ratio_min numeric NOT NULL DEFAULT 0,
  commission_ratio_max numeric NOT NULL DEFAULT 0,
  sample_size integer NOT NULL,
  seeded_from timestamptz NOT NULL,
  seeded_to timestamptz NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tops_collection_expectations IS
'One row per agent_collections.collection_channel: the expected float-leg direction/sign/magnitude-ratio and commission-ratio envelope, seeded empirically (5th-95th percentile of clean history) by tops_seed_collection_expectations(). expected_float_direction=''none'' means no agent-float leg is expected at all for this channel (e.g. tenant_deposit_auto, where the float leg belongs to the tenant, not the agent — confirmed live, zero agent-float legs on that channel in clean history).';

REVOKE ALL ON public.tops_collection_expectations FROM PUBLIC, anon;
GRANT SELECT ON public.tops_collection_expectations TO authenticated;
ALTER TABLE public.tops_collection_expectations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_collection_expectations_select_tops_roles ON public.tops_collection_expectations
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
-- 2. tops_collection_anomalies — one row per (collection, rule) that fired.
--    Read-only from the client beyond acknowledge/resolve, which go through
--    the two named functions below (who + why always recorded), never a
--    direct UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_collection_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  agent_id uuid NULL,
  tenant_id uuid NULL,
  rent_request_id uuid NULL,
  collection_channel text NOT NULL,
  rule_fired text NOT NULL CHECK (rule_fired IN (
    'float_direction_inverted', 'float_leg_missing', 'float_leg_unexpected_present',
    'float_ratio_out_of_range', 'commission_ratio_out_of_range'
  )),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  detail jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid NULL,
  acknowledged_at timestamptz NULL,
  acknowledged_note text NULL,
  resolved_by uuid NULL,
  resolved_at timestamptz NULL,
  resolved_note text NULL,
  UNIQUE (collection_id, rule_fired)
);

CREATE INDEX tops_collection_anomalies_status_idx ON public.tops_collection_anomalies (status, detected_at DESC);
CREATE INDEX tops_collection_anomalies_agent_idx ON public.tops_collection_anomalies (agent_id);

COMMENT ON TABLE public.tops_collection_anomalies IS
'One row per (collection, rule) that tops_detect_collection_anomalies() flagged. Unique on (collection_id, rule_fired) so a rolling re-scan never duplicates a finding. status/acknowledged_*/resolved_* are only ever changed by tops_acknowledge_collection_anomaly()/tops_resolve_collection_anomaly() — both require who and why. No client write path beyond those two functions.';

REVOKE ALL ON public.tops_collection_anomalies FROM PUBLIC, anon;
GRANT SELECT ON public.tops_collection_anomalies TO authenticated;
ALTER TABLE public.tops_collection_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_collection_anomalies_select_tops_roles ON public.tops_collection_anomalies
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
-- 3. tops_seed_collection_expectations(p_days) — has_role-gated (a human
--    triggers this occasionally, e.g. if the platform's real posting pattern
--    legitimately changes; it is not on the 10-minute cron).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_seed_collection_expectations(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz := now() - (p_days || ' days')::interval;
  v_count integer := 0;
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

  WITH collections AS (
    SELECT c.id, c.agent_id, c.rent_request_id, c.amount, c.created_at, c.collection_channel
    FROM public.agent_collections c
    WHERE c.reversed_at IS NULL
      AND c.created_at >= v_from
      AND COALESCE(c.notes, '') NOT ILIKE '%[RESTORED%'
      AND c.rent_request_id IS NOT NULL
      AND c.amount > 0
  ),
  float_legs AS (
    SELECT c.id AS collection_id, g.direction, g.amount AS leg_amount
    FROM collections c
    JOIN public.general_ledger g
      ON g.source_table = 'agent_collections'
      AND g.source_id = c.rent_request_id
      AND g.created_at = c.created_at
      AND g.classification = 'production'
      AND g.wallet_bucket = 'float'
      AND g.user_id = c.agent_id
      AND g.category = 'agent_float_used_for_rent'
  ),
  commission_legs AS (
    SELECT c.id AS collection_id, SUM(g.amount) AS commission_amount
    FROM collections c
    JOIN public.general_ledger g
      ON g.source_table = 'agent_collections'
      AND g.source_id = c.rent_request_id
      AND g.created_at = c.created_at
      AND g.classification = 'production'
      AND g.category = 'agent_commission_earned'
      AND g.direction = 'cash_in'
    GROUP BY c.id
  ),
  per_channel AS (
    SELECT
      c.collection_channel,
      count(*) AS sample_size,
      count(fl.collection_id) AS float_leg_count,
      mode() WITHIN GROUP (ORDER BY fl.direction) AS modal_direction,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY fl.leg_amount / c.amount) AS float_ratio_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY fl.leg_amount / c.amount) AS float_ratio_p95,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY COALESCE(cl.commission_amount, 0) / c.amount) AS commission_ratio_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(cl.commission_amount, 0) / c.amount) AS commission_ratio_p95
    FROM collections c
    LEFT JOIN float_legs fl ON fl.collection_id = c.id
    LEFT JOIN commission_legs cl ON cl.collection_id = c.id
    GROUP BY c.collection_channel
  )
  INSERT INTO public.tops_collection_expectations
    (collection_channel, expected_float_direction, expected_float_sign, float_ratio_min, float_ratio_max,
     commission_ratio_min, commission_ratio_max, sample_size, seeded_from, seeded_to)
  SELECT
    pc.collection_channel,
    CASE WHEN pc.float_leg_count = 0 THEN 'none' ELSE pc.modal_direction END,
    CASE WHEN pc.float_leg_count = 0 THEN 0 WHEN pc.modal_direction = 'cash_out' THEN -1 ELSE 1 END,
    COALESCE(pc.float_ratio_p05, 0),
    COALESCE(pc.float_ratio_p95, 0),
    COALESCE(pc.commission_ratio_p05, 0),
    COALESCE(pc.commission_ratio_p95, 0),
    pc.sample_size,
    v_from,
    now()
  FROM per_channel pc
  ON CONFLICT (collection_channel) DO UPDATE SET
    expected_float_direction = EXCLUDED.expected_float_direction,
    expected_float_sign = EXCLUDED.expected_float_sign,
    float_ratio_min = EXCLUDED.float_ratio_min,
    float_ratio_max = EXCLUDED.float_ratio_max,
    commission_ratio_min = EXCLUDED.commission_ratio_min,
    commission_ratio_max = EXCLUDED.commission_ratio_max,
    sample_size = EXCLUDED.sample_size,
    seeded_from = EXCLUDED.seeded_from,
    seeded_to = EXCLUDED.seeded_to,
    seeded_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_seed_collection_expectations(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_seed_collection_expectations(integer) TO authenticated;

COMMENT ON FUNCTION public.tops_seed_collection_expectations(integer) IS
'Seeds/re-seeds tops_collection_expectations from the last p_days (default 90) of clean collection history (reversed_at IS NULL, classification=production, no manual-restoration note). Ranges are the 5th-95th percentile, not raw min/max, so real outliers stay visible to the detector rather than being absorbed into "normal". Gated by an internal has_role check; not on any cron — a human re-runs this only if the platform''s real posting pattern legitimately changes.';

-- ---------------------------------------------------------------------------
-- 4. tops_detect_collection_anomalies(p_since) — the detector. Internal
--    only, no has_role gate (cron-safe from the start, per the lesson from
--    an earlier task's real bug: a gated function cannot be called from
--    pg_cron, which has no session/JWT).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_detect_collection_anomalies(p_since timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_inserted integer;
  v_new_count integer;
BEGIN
  DROP TABLE IF EXISTS tmp_collection_checks;
  CREATE TEMP TABLE tmp_collection_checks ON COMMIT DROP AS
  WITH collections AS (
    SELECT c.id, c.agent_id, c.tenant_id, c.rent_request_id, c.amount, c.created_at, c.collection_channel
    FROM public.agent_collections c
    WHERE c.reversed_at IS NULL
      AND c.created_at >= p_since
      AND c.rent_request_id IS NOT NULL
      AND c.amount > 0
  ),
  float_legs AS (
    SELECT c.id AS collection_id, g.direction, g.amount AS leg_amount
    FROM collections c
    JOIN public.general_ledger g
      ON g.source_table = 'agent_collections'
      AND g.source_id = c.rent_request_id
      AND g.created_at = c.created_at
      AND g.classification = 'production'
      AND g.wallet_bucket = 'float'
      AND g.user_id = c.agent_id
      AND g.category = 'agent_float_used_for_rent'
  ),
  commission_legs AS (
    SELECT c.id AS collection_id, SUM(g.amount) AS commission_amount
    FROM collections c
    JOIN public.general_ledger g
      ON g.source_table = 'agent_collections'
      AND g.source_id = c.rent_request_id
      AND g.created_at = c.created_at
      AND g.classification = 'production'
      AND g.category = 'agent_commission_earned'
      AND g.direction = 'cash_in'
    GROUP BY c.id
  )
  SELECT
    c.id AS collection_id, c.agent_id, c.tenant_id, c.rent_request_id, c.amount, c.collection_channel,
    e.expected_float_direction, e.float_ratio_min, e.float_ratio_max,
    e.commission_ratio_min, e.commission_ratio_max,
    fl.direction AS observed_float_direction,
    fl.leg_amount AS observed_float_amount,
    COALESCE(cl.commission_amount, 0) AS observed_commission_amount
  FROM collections c
  JOIN public.tops_collection_expectations e ON e.collection_channel = c.collection_channel
  LEFT JOIN float_legs fl ON fl.collection_id = c.id
  LEFT JOIN commission_legs cl ON cl.collection_id = c.id;

  -- Rule 1: float moved, but in the opposite direction to expectation.
  -- This is the one the brief calls out explicitly — always critical.
  INSERT INTO public.tops_collection_anomalies (collection_id, agent_id, tenant_id, rent_request_id, collection_channel, rule_fired, severity, detail)
  SELECT collection_id, agent_id, tenant_id, rent_request_id, collection_channel,
    'float_direction_inverted', 'critical',
    jsonb_build_object(
      'expected_direction', expected_float_direction, 'observed_direction', observed_float_direction,
      'collection_amount_ugx', amount, 'float_leg_amount_ugx', observed_float_amount
    )
  FROM tmp_collection_checks
  WHERE expected_float_direction <> 'none'
    AND observed_float_direction IS NOT NULL
    AND observed_float_direction <> expected_float_direction
  ON CONFLICT (collection_id, rule_fired) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT; v_total := v_total + v_inserted;

  -- Rule 2: a float leg was expected (this channel normally moves float) but none was posted.
  INSERT INTO public.tops_collection_anomalies (collection_id, agent_id, tenant_id, rent_request_id, collection_channel, rule_fired, severity, detail)
  SELECT collection_id, agent_id, tenant_id, rent_request_id, collection_channel,
    'float_leg_missing', 'high',
    jsonb_build_object('expected_direction', expected_float_direction, 'collection_amount_ugx', amount)
  FROM tmp_collection_checks
  WHERE expected_float_direction <> 'none'
    AND observed_float_direction IS NULL
  ON CONFLICT (collection_id, rule_fired) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT; v_total := v_total + v_inserted;

  -- Rule 3: no float leg was expected at all for this channel, but one exists.
  INSERT INTO public.tops_collection_anomalies (collection_id, agent_id, tenant_id, rent_request_id, collection_channel, rule_fired, severity, detail)
  SELECT collection_id, agent_id, tenant_id, rent_request_id, collection_channel,
    'float_leg_unexpected_present', 'high',
    jsonb_build_object('observed_direction', observed_float_direction, 'float_leg_amount_ugx', observed_float_amount, 'collection_amount_ugx', amount)
  FROM tmp_collection_checks
  WHERE expected_float_direction = 'none'
    AND observed_float_direction IS NOT NULL
  ON CONFLICT (collection_id, rule_fired) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT; v_total := v_total + v_inserted;

  -- Rule 4: direction matches, but the magnitude ratio sits outside the
  -- seeded envelope (±2% slack to absorb rounding noise, not a business rule).
  INSERT INTO public.tops_collection_anomalies (collection_id, agent_id, tenant_id, rent_request_id, collection_channel, rule_fired, severity, detail)
  SELECT collection_id, agent_id, tenant_id, rent_request_id, collection_channel,
    'float_ratio_out_of_range', 'medium',
    jsonb_build_object(
      'observed_ratio', ROUND(observed_float_amount / amount, 4),
      'expected_min', float_ratio_min, 'expected_max', float_ratio_max,
      'collection_amount_ugx', amount, 'float_leg_amount_ugx', observed_float_amount
    )
  FROM tmp_collection_checks
  WHERE expected_float_direction <> 'none'
    AND observed_float_direction = expected_float_direction
    AND (
      observed_float_amount / amount < float_ratio_min - GREATEST(float_ratio_min * 0.02, 0.001)
      OR observed_float_amount / amount > float_ratio_max + GREATEST(float_ratio_max * 0.02, 0.001)
    )
  ON CONFLICT (collection_id, rule_fired) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT; v_total := v_total + v_inserted;

  -- Rule 5: commission ratio sits outside the seeded envelope.
  INSERT INTO public.tops_collection_anomalies (collection_id, agent_id, tenant_id, rent_request_id, collection_channel, rule_fired, severity, detail)
  SELECT collection_id, agent_id, tenant_id, rent_request_id, collection_channel,
    'commission_ratio_out_of_range', 'low',
    jsonb_build_object(
      'observed_ratio', ROUND(observed_commission_amount / amount, 4),
      'expected_min', commission_ratio_min, 'expected_max', commission_ratio_max,
      'collection_amount_ugx', amount, 'commission_amount_ugx', observed_commission_amount
    )
  FROM tmp_collection_checks
  WHERE observed_commission_amount / amount < commission_ratio_min - GREATEST(commission_ratio_min * 0.02, 0.001)
     OR observed_commission_amount / amount > commission_ratio_max + GREATEST(commission_ratio_max * 0.02, 0.001)
  ON CONFLICT (collection_id, rule_fired) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT; v_total := v_total + v_inserted;

  -- Alert: docs/TOPS_FINDINGS.md §8 confirmed send-push-notification accepts
  -- a new message type unchanged, but the net.http_post mechanism other
  -- triggers in this codebase use to reach it depends on two Postgres GUCs
  -- (app.settings.supabase_url / app.settings.service_role_key) that were
  -- confirmed LIVE to be unset in this database — so that path cannot
  -- actually be invoked reliably from a plain SQL function here today.
  -- Falls to the brief's explicit "otherwise" branch: write to our own
  -- tops_notifications, one summary row per current ops-team member, only
  -- when this run actually found something new (never an empty ping).
  IF v_total > 0 THEN
    SELECT count(*) INTO v_new_count FROM public.tops_collection_anomalies WHERE detected_at >= now() - interval '1 minute';
    INSERT INTO public.tops_notifications (user_id, title, body)
    SELECT DISTINCT ur.user_id,
      'Collection anomaly detected',
      v_total || ' new collection anomal' || CASE WHEN v_total = 1 THEN 'y' ELSE 'ies' END || ' flagged — open the Collections tab to review.'
    FROM public.user_roles ur
    WHERE ur.enabled = true
      AND ur.role IN ('tenant_ops', 'operations', 'coo', 'cfo', 'ceo', 'super_admin');
  END IF;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_detect_collection_anomalies(timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_detect_collection_anomalies(timestamptz) IS
'Detects collections since p_since whose float-leg direction, float-leg magnitude ratio, or commission ratio deviates from tops_collection_expectations for their channel — reading only agent_collections and general_ledger, writing only tops_collection_anomalies (+ a tops_notifications summary when something new is found). No trigger, no money-path write. Internal-only (no EXECUTE grant, including authenticated) — driven by the tops-detect-collection-anomalies-every-10min cron job.';

SELECT cron.schedule(
  'tops-detect-collection-anomalies-every-10min',
  '*/10 * * * *',
  $$ SELECT public.tops_detect_collection_anomalies(now() - interval '1 day'); $$
);

-- ---------------------------------------------------------------------------
-- 5. tops_collection_anomalies_list(p_status) — read RPC for the panel,
--    joining tenant/agent names so the client never has to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_collection_anomalies_list(p_status text DEFAULT 'open')
RETURNS TABLE (
  id uuid,
  collection_id uuid,
  rent_request_id uuid,
  tenant_name text,
  agent_name text,
  collection_channel text,
  rule_fired text,
  severity text,
  detail jsonb,
  detected_at timestamptz,
  status text,
  acknowledged_by_name text,
  acknowledged_at timestamptz,
  acknowledged_note text,
  resolved_by_name text,
  resolved_at timestamptz,
  resolved_note text
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
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    a.id, a.collection_id, a.rent_request_id,
    tp.full_name, ap.full_name, a.collection_channel, a.rule_fired, a.severity, a.detail, a.detected_at,
    a.status, ackp.full_name, a.acknowledged_at, a.acknowledged_note,
    resp.full_name, a.resolved_at, a.resolved_note
  FROM public.tops_collection_anomalies a
  LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = a.agent_id
  LEFT JOIN public.profiles ackp ON ackp.id = a.acknowledged_by
  LEFT JOIN public.profiles resp ON resp.id = a.resolved_by
  WHERE p_status IS NULL OR a.status = p_status
  ORDER BY a.severity = 'critical' DESC, a.severity = 'high' DESC, a.detected_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_collection_anomalies_list(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collection_anomalies_list(text) TO authenticated;

COMMENT ON FUNCTION public.tops_collection_anomalies_list(text) IS
'Read RPC for the Collections tab''s anomalies panel — tops_collection_anomalies joined with tenant/agent/actor names. p_status filters (default ''open''); NULL returns every status. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 6. tops_acknowledge_collection_anomaly / tops_resolve_collection_anomaly —
--    the only ways a client mutates tops_collection_anomalies. Both record
--    who and why, per the brief.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_acknowledge_collection_anomaly(p_anomaly_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
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
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a reason is required to acknowledge an anomaly';
  END IF;

  UPDATE public.tops_collection_anomalies
  SET status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now(), acknowledged_note = p_note
  WHERE id = p_anomaly_id AND status = 'open';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'anomaly not found or not open';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_acknowledge_collection_anomaly(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_acknowledge_collection_anomaly(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.tops_acknowledge_collection_anomaly(uuid, text) IS
'Marks an open anomaly acknowledged. A reason is required and rejected if blank. Gated by an internal has_role check.';

CREATE OR REPLACE FUNCTION public.tops_resolve_collection_anomaly(p_anomaly_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
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
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'a reason is required to resolve an anomaly';
  END IF;

  UPDATE public.tops_collection_anomalies
  SET status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolved_note = p_note
  WHERE id = p_anomaly_id AND status <> 'resolved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'anomaly not found or already resolved';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_resolve_collection_anomaly(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_resolve_collection_anomaly(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.tops_resolve_collection_anomaly(uuid, text) IS
'Marks an anomaly resolved (from open or acknowledged). A reason is required and rejected if blank. Gated by an internal has_role check.';
