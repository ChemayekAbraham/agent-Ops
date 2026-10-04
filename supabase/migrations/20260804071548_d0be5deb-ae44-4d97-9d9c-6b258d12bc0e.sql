-- =========================================================================
-- Landlord verification state machine + gated write path + event log
-- =========================================================================

-- 0. Authorize verification writes for this migration session.
SELECT set_config('landlord_verification.sync_authorized', 'true', true);

-- 1. Columns -------------------------------------------------------------
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS verification_source text,
  ADD COLUMN IF NOT EXISTS verification_updated_at timestamptz;

-- 2. Append-only transition log -----------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid,
  reason text,
  source text NOT NULL DEFAULT 'unspecified',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.landlord_verification_events TO authenticated;
GRANT ALL ON public.landlord_verification_events TO service_role;
ALTER TABLE public.landlord_verification_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can read landlord verification events" ON public.landlord_verification_events;
CREATE POLICY "Ops can read landlord verification events"
  ON public.landlord_verification_events
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_lve_landlord ON public.landlord_verification_events(landlord_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lve_actor ON public.landlord_verification_events(actor_id, to_status, created_at DESC);

-- 3. Reconciliation backfill --------------------------------------------
-- 3a. normalise unknown states
UPDATE public.landlords
SET verification_status = 'pending'
WHERE COALESCE(NULLIF(btrim(verification_status), ''), 'pending')
      NOT IN ('pending','verified','rejected','resubmitted');

-- 3b. latest decided verification request wins
WITH latest AS (
  SELECT DISTINCT ON (landlord_id)
         landlord_id, status
  FROM public.landlord_verification_requests
  WHERE status IN ('verified','rejected')
    AND landlord_id IS NOT NULL
  ORDER BY landlord_id, COALESCE(resolved_at, created_at) DESC
)
UPDATE public.landlords l
SET verification_status = latest.status,
    verified = (latest.status = 'verified'),
    verification_source = CASE WHEN latest.status = 'verified'
                               THEN 'backfill_request_verified'
                               ELSE 'backfill_request_rejected' END,
    verification_updated_at = now()
FROM latest
WHERE l.id = latest.landlord_id
  AND (l.verification_status IS DISTINCT FROM latest.status
       OR l.verified IS DISTINCT FROM (latest.status = 'verified'));

-- 3c. pipeline-flipped landlords become explicitly verified, tagged auto
UPDATE public.landlords
SET verification_status = 'verified',
    verification_source = 'pipeline_auto',
    verification_updated_at = now()
WHERE verified IS TRUE
  AND COALESCE(NULLIF(btrim(verification_status), ''), 'pending') = 'pending';

-- 3d. everything else: default state + source
UPDATE public.landlords
SET verification_status = COALESCE(NULLIF(btrim(verification_status), ''), 'pending'),
    verification_source = COALESCE(verification_source,
      CASE WHEN COALESCE(NULLIF(btrim(verification_status), ''), 'pending') = 'verified'
           THEN 'ops_manual' ELSE 'registration' END)
WHERE verification_source IS NULL
   OR verification_status IS NULL
   OR btrim(verification_status) = '';

-- 3e. derived flag must equal the state, always
UPDATE public.landlords
SET verified = (verification_status = 'verified'),
    verification_updated_at = COALESCE(verification_updated_at, now())
WHERE verified IS DISTINCT FROM (verification_status = 'verified');

ALTER TABLE public.landlords
  ALTER COLUMN verification_status SET DEFAULT 'pending';

ALTER TABLE public.landlords DROP CONSTRAINT IF EXISTS landlords_verification_status_check;
ALTER TABLE public.landlords
  ADD CONSTRAINT landlords_verification_status_check
  CHECK (verification_status IN ('pending','verified','rejected','resubmitted'));

-- 4. Gate: single authorized write path ---------------------------------
CREATE OR REPLACE FUNCTION public.landlord_verification_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    IF NEW.verified IS TRUE AND NEW.verification_status = 'pending' THEN
      NEW.verification_status := 'verified';
    END IF;
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_source := COALESCE(NEW.verification_source, 'registration');
    NEW.verification_updated_at := COALESCE(NEW.verification_updated_at, now());
    RETURN NEW;
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.verified IS DISTINCT FROM OLD.verified
     OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verification_source IS DISTINCT FROM OLD.verification_source THEN

    IF COALESCE(current_setting('landlord_verification.sync_authorized', true), '') <> 'true' THEN
      RAISE EXCEPTION 'Landlord verification is locked. Use set_landlord_verification() (landlord %)', OLD.id
        USING ERRCODE = '42501';
    END IF;

    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aa_landlord_verification_gate ON public.landlords;
CREATE TRIGGER trg_aa_landlord_verification_gate
  BEFORE INSERT OR UPDATE ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.landlord_verification_gate();

-- 4b. the legacy column guard must not silently revert authorized writes
CREATE OR REPLACE FUNCTION public.guard_landlord_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Verification columns are owned by landlord_verification_gate(); never
  -- reverted here when the authorized path is active.
  IF COALESCE(current_setting('landlord_verification.sync_authorized', true), '') <> 'true' THEN
    NEW.verified := OLD.verified;
    NEW.verified_at := OLD.verified_at;
    NEW.verified_by := OLD.verified_by;
    NEW.verification_status := OLD.verification_status;
    NEW.verification_reason := OLD.verification_reason;
    NEW.verification_source := OLD.verification_source;
    NEW.verification_updated_at := OLD.verification_updated_at;
  END IF;

  IF public.is_sensitive_field_editor(auth.uid())
     OR public.has_role(auth.uid(), 'agent'::app_role)
     OR public.has_role(auth.uid(), 'senior_agent'::app_role) THEN
    RETURN NEW;
  END IF;

  NEW.verification_pin_1 := OLD.verification_pin_1;
  NEW.verification_pin_2 := OLD.verification_pin_2;
  NEW.rent_balance_due := OLD.rent_balance_due;
  NEW.rent_last_paid_at := OLD.rent_last_paid_at;
  NEW.rent_last_paid_amount := OLD.rent_last_paid_amount;
  NEW.bank_name := OLD.bank_name;
  NEW.account_number := OLD.account_number;
  NEW.registration_bonus_paid := OLD.registration_bonus_paid;
  NEW.registration_bonus_paid_at := OLD.registration_bonus_paid_at;
  NEW.registration_verification_bonus_paid := OLD.registration_verification_bonus_paid;
  NEW.registration_verification_bonus_paid_at := OLD.registration_verification_bonus_paid_at;
  RETURN NEW;
END;
$$;

-- 5. Immutable transition log trigger -----------------------------------
CREATE OR REPLACE FUNCTION public.log_landlord_verification_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.verification_status IS NOT DISTINCT FROM OLD.verification_status THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.landlord_verification_events
    (landlord_id, from_status, to_status, actor_id, reason, source)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.verification_status ELSE NULL END,
    NEW.verification_status,
    COALESCE(auth.uid(), NEW.verified_by),
    NEW.verification_reason,
    COALESCE(NEW.verification_source, 'unspecified')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_landlord_verification_event ON public.landlords;
CREATE TRIGGER trg_log_landlord_verification_event
  AFTER INSERT OR UPDATE OF verification_status ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.log_landlord_verification_event();

-- 5b. seed the log with the reconciled current state
INSERT INTO public.landlord_verification_events
  (landlord_id, from_status, to_status, actor_id, reason, source, created_at)
SELECT l.id, NULL, l.verification_status, l.verified_by,
       'Reconciliation backfill of landlord verification state',
       'backfill_' || COALESCE(l.verification_source, 'unspecified'),
       COALESCE(l.verification_updated_at, l.verified_at, l.created_at, now())
FROM public.landlords l
WHERE NOT EXISTS (
  SELECT 1 FROM public.landlord_verification_events e WHERE e.landlord_id = l.id
);

-- 6. The one authorized write path --------------------------------------
DROP FUNCTION IF EXISTS public.set_landlord_verification(uuid, text, text);
CREATE OR REPLACE FUNCTION public.set_landlord_verification(
  p_landlord_id uuid,
  p_status text,
  p_reason text,
  p_source text DEFAULT 'ops_manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected','resubmitted') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);

  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_landlord_id
  RETURNING name, registered_by INTO v_name, v_registered_by;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  UPDATE public.landlord_verification_requests
  SET status = CASE WHEN p_status IN ('verified','rejected') THEN p_status ELSE 'pending' END,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', v_reason, 'source', p_source));

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' GPS location has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'Landlord verification rejected';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'Landlord verification pending';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'landlord_verification', 'landlord_id', p_landlord_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_landlord_id = p_landlord_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Recovery: landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX')
        ),
        'landlord_rejection_charge:' || p_landlord_id::text,
        true
      );
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, '🚫 Landlord Rejected',
      'The landlord "' || COALESCE(v_name, 'landlord') || '" you registered was rejected. Reason: ' || v_reason ||
        CASE WHEN v_agent_charged THEN '. A UGX ' || v_charge_amount || ' charge was applied to your wallet.' ELSE '' END,
      'warning',
      jsonb_build_object('kind', 'landlord_rejection_penalty', 'landlord_id', p_landlord_id, 'landlord_name', v_name,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END, 'action', 'landlord_rejected'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'status', p_status,
    'source', COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
    'agent_id', v_registered_by, 'agent_charged', v_agent_charged,
    'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text, text) TO authenticated;

-- 7. Pipeline auto-verification routed through the gate ------------------
CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_ops_reviewed_at IS NOT NULL AND NEW.landlord_id IS NOT NULL THEN
    PERFORM set_config('landlord_verification.sync_authorized', 'true', true);

    UPDATE public.landlords
       SET verification_status = 'verified',
           verification_source = COALESCE(verification_source, 'pipeline_auto'),
           verification_reason = COALESCE(verification_reason, 'Auto-verified by rent pipeline approval'),
           verified_at = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.landlord_id
       AND COALESCE(verification_status, 'pending') = 'pending';

    PERFORM set_config('landlord_verification.sync_authorized', 'false', true);
  END IF;

  RETURN NEW;
END;
$$;

-- 8. One query definition for counts AND rows ---------------------------
CREATE OR REPLACE VIEW public.v_landlord_ops_status AS
WITH tc AS (
  SELECT src.landlord_id AS lid, count(DISTINCT src.tenant_id)::int AS cnt
  FROM (
    SELECT hl.landlord_id, hl.tenant_id FROM public.house_listings hl
      WHERE hl.tenant_id IS NOT NULL AND hl.landlord_id IS NOT NULL
    UNION
    SELECT rr.landlord_id, rr.tenant_id FROM public.rent_requests rr
      WHERE rr.tenant_id IS NOT NULL AND rr.landlord_id IS NOT NULL
  ) src
  GROUP BY src.landlord_id
)
SELECT
  l.id                                                                      AS landlord_id,
  COALESCE(NULLIF(btrim(l.verification_status), ''), 'pending')              AS status,
  COALESCE(l.verification_source, 'unspecified')                            AS source,
  COALESCE(tc.cnt, 0)                                                       AS tenant_count,
  (COALESCE(tc.cnt, 0) > 0 OR l.tenant_id IS NOT NULL)                      AS has_tenant,
  COALESCE(l.monthly_rent, 0)                                               AS monthly_rent,
  l.has_smartphone
FROM public.landlords l
LEFT JOIN tc ON tc.lid = l.id;

GRANT SELECT ON public.v_landlord_ops_status TO authenticated;
GRANT SELECT ON public.v_landlord_ops_status TO service_role;

DROP FUNCTION IF EXISTS public.get_landlord_ops_totals();
CREATE OR REPLACE FUNCTION public.get_landlord_ops_totals()
RETURNS TABLE(
  total bigint, verified bigint, pending bigint, rejected bigint, resubmitted bigint,
  verified_human bigint, verified_auto bigint,
  has_tenants bigint, no_tenants bigint, smartphone bigint,
  occupied_monthly_revenue numeric, empty_monthly_revenue numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE v.status = 'verified')::bigint,
    count(*) FILTER (WHERE v.status = 'pending')::bigint,
    count(*) FILTER (WHERE v.status = 'rejected')::bigint,
    count(*) FILTER (WHERE v.status = 'resubmitted')::bigint,
    count(*) FILTER (WHERE v.status = 'verified' AND v.source <> 'pipeline_auto')::bigint,
    count(*) FILTER (WHERE v.status = 'verified' AND v.source = 'pipeline_auto')::bigint,
    count(*) FILTER (WHERE v.has_tenant)::bigint,
    count(*) FILTER (WHERE NOT v.has_tenant)::bigint,
    count(*) FILTER (WHERE v.has_smartphone IS TRUE)::bigint,
    COALESCE(sum(v.monthly_rent) FILTER (WHERE v.has_tenant), 0),
    COALESCE(sum(v.monthly_rent) FILTER (WHERE NOT v.has_tenant), 0)
  FROM public.v_landlord_ops_status v;
$$;

-- 9. Rows RPC: same predicate source, exposes state + source -------------
DROP FUNCTION IF EXISTS public.get_landlord_ops_rows(text, text, text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.get_landlord_ops_rows(
  _search text DEFAULT NULL,
  _sort text DEFAULT 'newest',
  _category text DEFAULT 'all',
  _pending_filter text DEFAULT 'all',
  _limit integer DEFAULT 20,
  _offset integer DEFAULT 0
)
RETURNS TABLE(
  id uuid, name text, phone text, verified boolean, verification_status text, verification_source text,
  verification_reason text, verification_updated_at timestamptz,
  has_smartphone boolean, mobile_money_name text, mobile_money_number text, number_of_houses integer,
  bank_name text, account_number text, monthly_rent numeric, caretaker_name text, caretaker_phone text,
  tin text, electricity_meter_number text, water_meter_number text, village text, district text,
  region text, property_address text, tenant_id uuid, registered_by uuid, managed_by_agent_id uuid,
  house_category text, number_of_rooms integer, created_at timestamptz, tenant_count integer,
  agent_name text, agent_phone text, primary_tenant_name text, primary_tenant_phone text,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(_limit, 20), 1), 200);
  v_offset int := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(_search, '')), '');
  v_like text := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || lower(v_search) || '%' END;
  -- When searching, status scoping is bypassed so any match surfaces with its
  -- own badge; tenant-scoped categories still apply.
  v_bypass_status boolean := v_search IS NOT NULL;
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      l.id, l.name, l.phone, l.verified,
      v.status AS v_status, v.source AS v_source,
      l.verification_reason, l.verification_updated_at,
      l.has_smartphone, l.mobile_money_name, l.mobile_money_number,
      l.number_of_houses, l.bank_name, l.account_number, l.monthly_rent, l.caretaker_name, l.caretaker_phone,
      l.tin, l.electricity_meter_number, l.water_meter_number, l.village, l.district, l.region,
      l.property_address, l.tenant_id, l.registered_by, l.managed_by_agent_id, l.house_category,
      l.number_of_rooms, l.created_at,
      v.tenant_count AS tc_count,
      v.has_tenant
    FROM public.landlords l
    JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
  ),
  filtered AS (
    SELECT * FROM base b
    WHERE (
        (v_bypass_status AND _category IN ('all','verified','pending','rejected','resubmitted'))
        OR _category = 'all'
        OR (_category = 'verified'    AND b.v_status = 'verified')
        OR (_category = 'pending'     AND b.v_status = 'pending')
        OR (_category = 'rejected'    AND b.v_status = 'rejected')
        OR (_category = 'resubmitted' AND b.v_status = 'resubmitted')
        OR (_category = 'has_tenants' AND b.has_tenant)
        OR (_category = 'no_tenants'  AND NOT b.has_tenant)
      )
      AND (
        _category <> 'pending'
        OR _pending_filter = 'all'
        OR (_pending_filter = 'has_address'    AND b.property_address IS NOT NULL AND btrim(b.property_address) <> '')
        OR (_pending_filter = 'has_phone'      AND b.phone IS NOT NULL AND length(b.phone) >= 9)
        OR (_pending_filter = 'has_smartphone' AND b.has_smartphone IS TRUE)
        OR (_pending_filter = 'has_bank'       AND b.bank_name IS NOT NULL AND b.account_number IS NOT NULL)
        OR (_pending_filter = 'has_momo'       AND b.mobile_money_number IS NOT NULL)
      )
      AND (
        v_like IS NULL
        OR lower(COALESCE(b.name, ''))             LIKE v_like
        OR lower(COALESCE(b.phone, ''))            LIKE v_like
        OR lower(COALESCE(b.district, ''))         LIKE v_like
        OR lower(COALESCE(b.region, ''))           LIKE v_like
        OR lower(COALESCE(b.village, ''))          LIKE v_like
        OR lower(COALESCE(b.property_address, '')) LIKE v_like
      )
  ),
  counted AS (
    SELECT f.*, count(*) OVER () AS tm FROM filtered f
  )
  SELECT
    c.id, c.name, c.phone, c.verified, c.v_status, c.v_source,
    c.verification_reason, c.verification_updated_at,
    c.has_smartphone, c.mobile_money_name, c.mobile_money_number,
    c.number_of_houses, c.bank_name, c.account_number, c.monthly_rent, c.caretaker_name, c.caretaker_phone,
    c.tin, c.electricity_meter_number, c.water_meter_number, c.village, c.district, c.region,
    c.property_address, c.tenant_id, c.registered_by, c.managed_by_agent_id, c.house_category,
    c.number_of_rooms, c.created_at,
    c.tc_count AS tenant_count,
    COALESCE(pa_mgr.full_name, pa_reg.full_name) AS agent_name,
    COALESCE(pa_mgr.phone, pa_reg.phone)         AS agent_phone,
    pt.full_name                                  AS primary_tenant_name,
    pt.phone                                      AS primary_tenant_phone,
    c.tm                                          AS total_matched
  FROM counted c
  LEFT JOIN public.profiles pa_mgr ON pa_mgr.id = c.managed_by_agent_id
  LEFT JOIN public.profiles pa_reg ON pa_reg.id = c.registered_by
  LEFT JOIN public.profiles pt     ON pt.id     = c.tenant_id
  ORDER BY
    CASE WHEN v_search IS NOT NULL AND c.v_status = 'verified' THEN 0 ELSE 1 END ASC,
    CASE WHEN _sort = 'oldest'       THEN c.created_at END ASC NULLS LAST,
    CASE WHEN _sort = 'highest_rent' THEN c.monthly_rent END DESC NULLS LAST,
    CASE WHEN _sort NOT IN ('oldest','highest_rent') THEN c.created_at END DESC NULLS LAST
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

-- 10. Verifier attribution from the immutable log -----------------------
CREATE OR REPLACE FUNCTION public.get_landlord_verification_actors(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE(actor_id uuid, actor_name text, verified_count bigint, rejected_count bigint, last_action_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.actor_id,
         COALESCE(p.full_name, 'System / automatic') AS actor_name,
         count(*) FILTER (WHERE e.to_status = 'verified')::bigint,
         count(*) FILTER (WHERE e.to_status = 'rejected')::bigint,
         max(e.created_at)
  FROM public.landlord_verification_events e
  LEFT JOIN public.profiles p ON p.id = e.actor_id
  WHERE public.is_ops_role(auth.uid())
    AND e.source NOT LIKE 'backfill%'
    AND (p_from IS NULL OR e.created_at >= p_from)
    AND (p_to   IS NULL OR e.created_at <  p_to)
  GROUP BY e.actor_id, p.full_name
  ORDER BY 3 DESC, 4 DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_landlord_verification_actors(timestamptz, timestamptz) TO authenticated;

-- 11. Fix broken ops search (landlords has no agent_id column) -----------
CREATE OR REPLACE FUNCTION public.ops_search_landlords(
  p_query text DEFAULT NULL,
  p_verified_only boolean DEFAULT true,
  p_limit integer DEFAULT 50,
  p_cursor_name text DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, phone text, district text, town_council text, house_category text,
              monthly_rent numeric, verified boolean, created_at timestamptz, agent_id uuid, tenant_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_q text; v_lim int := LEAST(GREATEST(COALESCE(p_limit,50),1),200);
BEGIN
  IF NOT public.ops_caller_is_ops() THEN RETURN; END IF;
  v_q := NULLIF(TRIM(COALESCE(p_query,'')),'');
  RETURN QUERY
  SELECT l.id, l.name, l.phone, l.district, l.town_council,
         l.house_category, l.monthly_rent, l.verified, l.created_at,
         COALESCE(l.managed_by_agent_id, l.registered_by) AS agent_id,
         l.tenant_id
  FROM public.landlords l
  WHERE (NOT p_verified_only OR l.verified = true)
    AND (v_q IS NULL OR l.name ILIKE '%'||v_q||'%' OR l.phone ILIKE '%'||v_q||'%')
    AND (p_cursor_name IS NULL OR (l.name, l.id) > (p_cursor_name, p_cursor_id))
  ORDER BY l.name ASC, l.id ASC LIMIT v_lim;
END; $$;