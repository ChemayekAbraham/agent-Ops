-- CFO advance gate override
-- =========================
-- Business decision (2026-09-08): the CFO must be able to issue an agent advance
-- regardless of any eligibility condition that would otherwise block it.
--
-- Every gate stays ON for the normal agent-initiated and ops-approved flows. The
-- only thing that changes is that a CFO (or CEO / super_admin / admin) can stamp a
-- request as an explicit, attributed, audited override, and the gates then stand
-- down for that one request.
--
-- Gates covered:
--   agent_advance_requests
--     trg_enforce_agent_advance_min_principal  - UGX 10,000 floor
--     trg_enforce_no_double_agent_advance      - ongoing advance / pending request
--     trg_enforce_tiered_advance_rate          - silently rewrites the rate to 33%/28%
--     zz_enforce_agent_advance_activity        - ADVANCE_NO_ACTIVITY
--     zz_enforce_no_duplicate_account_advance  - DUPLICATE_ACCOUNT_BLOCKED
--   agent_advances
--     trg_enforce_agent_advance_row_min_principal - UGX 10,000 floor
--     trg_enforce_advance_principal_integrity     - UGX 1,000 floor, rate <= 33%
--   disburse_agent_advance_request                - its own principal/rate checks
--
-- The override CANNOT be self-granted: aaa_guard_advance_gate_override rejects the
-- flag unless the caller actually holds an authorised role.

-- ---------------------------------------------------------------------------
-- 1. Override columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.agent_advance_requests
  ADD COLUMN IF NOT EXISTS gate_override        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gate_override_by     uuid,
  ADD COLUMN IF NOT EXISTS gate_override_at     timestamptz,
  ADD COLUMN IF NOT EXISTS gate_override_reason text,
  ADD COLUMN IF NOT EXISTS gate_override_gates  text[];

ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS gate_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_advance_requests.gate_override IS
  'CFO override: eligibility gates stood down for this request. Only settable by cfo/ceo/super_admin/admin.';
COMMENT ON COLUMN public.agent_advance_requests.gate_override_gates IS
  'Which gates the override actually bypassed, recorded at insert time for audit.';

-- ---------------------------------------------------------------------------
-- 2. Who may override
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_override_advance_gates(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT p_user_id IS NOT NULL AND (
    has_role(p_user_id, 'cfo'::app_role)
    OR has_role(p_user_id, 'ceo'::app_role)
    OR has_role(p_user_id, 'super_admin'::app_role)
    OR has_role(p_user_id, 'admin'::app_role)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.can_override_advance_gates(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The override cannot be self-granted.
--    Named aaa_* so it fires before every other BEFORE-row trigger on the table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_advance_gate_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_was   boolean := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.gate_override, false) ELSE false END;
BEGIN
  IF NOT COALESCE(NEW.gate_override, false) THEN
    RETURN NEW;
  END IF;

  -- An override already granted survives ordinary updates (status moves, disbursement).
  IF TG_OP = 'UPDATE' AND v_was THEN
    RETURN NEW;
  END IF;

  -- auth.uid() IS NULL means a service_role / cron context, which is trusted.
  IF v_actor IS NOT NULL AND NOT public.can_override_advance_gates(v_actor) THEN
    RAISE EXCEPTION 'ADVANCE_OVERRIDE_FORBIDDEN: only the CFO, CEO or an administrator can override advance eligibility gates.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NULLIF(btrim(COALESCE(NEW.gate_override_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'ADVANCE_OVERRIDE_REASON_REQUIRED: an override must record why the gates were bypassed.'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.gate_override_by := COALESCE(NEW.gate_override_by, v_actor);
  NEW.gate_override_at := COALESCE(NEW.gate_override_at, now());
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS aaa_guard_advance_gate_override ON public.agent_advance_requests;
CREATE TRIGGER aaa_guard_advance_gate_override
BEFORE INSERT OR UPDATE ON public.agent_advance_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_advance_gate_override();

-- ---------------------------------------------------------------------------
-- 4. Stand the request-side gates down when the override is set.
--    Each function body is otherwise byte-for-byte what production already runs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_agent_advance_min_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_min_principal CONSTANT NUMERIC := 10000;
BEGIN
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  -- Only enforce on transitions into approval/payment states
  IF NEW.status IN ('agent_ops_approved', 'cfo_approved', 'cfo_paid')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
  THEN
    IF COALESCE(NEW.principal, 0) < v_min_principal THEN
      RAISE EXCEPTION 'Advance principal (UGX %) is below the minimum of UGX 10,000. Reject the request instead of approving a token amount.',
        COALESCE(NEW.principal, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_no_double_agent_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_elig jsonb;
BEGIN
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  IF NEW.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.request_kind,'new') = 'topup' THEN
    IF TG_OP = 'INSERT' THEN
      v_elig := public.agent_advance_topup_eligibility(NEW.agent_id);
      IF NOT (v_elig->>'eligible')::boolean THEN
        RAISE EXCEPTION 'Top-up not allowed: %', COALESCE(v_elig->>'reason','not eligible')
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.parent_advance_id IS NULL THEN
        NEW.parent_advance_id := (v_elig->>'advance_id')::uuid;
      ELSIF NEW.parent_advance_id <> (v_elig->>'advance_id')::uuid THEN
        RAISE EXCEPTION 'Top-up must target the current ongoing advance.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF COALESCE(NEW.extend_days,0) <= 0 THEN
        RAISE EXCEPTION 'Top-up requires the number of days to extend the schedule by.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.principal < (v_elig->>'min_topup')::numeric
         OR NEW.principal > (v_elig->>'max_topup')::numeric THEN
        RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX % (90%% of the current advance).',
          (v_elig->>'min_topup'), (v_elig->>'max_topup')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_advances
    WHERE agent_id = NEW.agent_id
      AND status IN ('active','overdue')
      AND outstanding_balance > 0
  ) THEN
    RAISE EXCEPTION 'Agent already has an ongoing advance with an outstanding balance. Request a top-up instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.agent_advance_requests
    WHERE agent_id = NEW.agent_id
      AND id <> NEW.id
      AND status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
  ) THEN
    RAISE EXCEPTION 'Agent already has a pending advance request in the approval pipeline.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_tiered_advance_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_completed_count INT;
  v_expected_rate NUMERIC;
  v_recompute_fees BOOLEAN := false;
BEGIN
  -- Override: the rate the CFO typed is the rate that stands. Without this the
  -- trigger silently rewrites monthly_rate to 0.33/0.28 and recomputes the fees,
  -- so a hand-set rate never survived the insert.
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  SELECT COUNT(*) INTO v_completed_count
  FROM public.agent_advances
  WHERE agent_id = NEW.agent_id
    AND status = 'completed';

  v_expected_rate := CASE WHEN v_completed_count > 0 THEN 0.28 ELSE 0.33 END;

  IF NEW.monthly_rate IS DISTINCT FROM v_expected_rate THEN
    NEW.monthly_rate := v_expected_rate;
    v_recompute_fees := true;
  END IF;

  IF v_recompute_fees AND NEW.principal IS NOT NULL AND NEW.cycle_days IS NOT NULL THEN
    NEW.access_fee := ROUND(NEW.principal * v_expected_rate * (NEW.cycle_days::NUMERIC / 30.0));
    NEW.total_payable := NEW.principal + COALESCE(NEW.access_fee,0) + COALESCE(NEW.registration_fee,0);
    IF NEW.cycle_days > 0 THEN
      NEW.daily_payment := ROUND(NEW.total_payable / NEW.cycle_days);
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_agent_advance_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  v := public.agent_advance_activity(NEW.agent_id);

  IF NOT (v->>'eligible')::boolean THEN
    RAISE EXCEPTION 'ADVANCE_NO_ACTIVITY: You have not recorded any agent work yet. Recruit a sub-agent, raise a rent request for a tenant, collect rent, activate a promissory note, or get a house you listed verified — then you can request an advance.';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_no_duplicate_account_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_name_key text;
  v_dup record;
BEGIN
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  IF NEW.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_duplicate_flags f
    WHERE f.agent_id = NEW.agent_id AND f.status = 'active'
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_ACCOUNT_BLOCKED: This account is flagged as a duplicate account and cannot request an advance. Contact support to resolve the duplication.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT nullif(lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')), '')
    INTO v_name_key
  FROM public.profiles p WHERE p.id = NEW.agent_id;

  IF v_name_key IS NULL OR length(v_name_key) < 6 THEN
    RETURN NEW;
  END IF;

  SELECT p.id, p.full_name INTO v_dup
  FROM public.profiles p
  WHERE p.id <> NEW.agent_id
    AND lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')) = v_name_key
    AND (
      EXISTS (
        SELECT 1 FROM public.agent_advances a
        WHERE a.agent_id = p.id AND a.status IN ('active','overdue') AND a.outstanding_balance > 0
      )
      OR EXISTS (
        SELECT 1 FROM public.agent_advance_requests r
        WHERE r.agent_id = p.id
          AND r.status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
      )
    )
  LIMIT 1;

  IF v_dup.id IS NOT NULL THEN
    RAISE EXCEPTION 'DUPLICATE_ACCOUNT_BLOCKED: Another account with the same full name (%) already has an advance or a pending advance request. One advance per person is allowed.', coalesce(v_dup.full_name,'same name')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Stand the agent_advances-side gates down for an overridden advance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_agent_advance_row_min_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  IF COALESCE(NEW.principal, 0) < 10000 THEN
    RAISE EXCEPTION 'Cannot create an agent advance with principal below UGX 10,000 (got UGX %).', COALESCE(NEW.principal, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_advance_principal_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Rule 1: on UPDATE, principal is immutable-upward. It may only stay the same or
  -- decrease. This rule is deliberately NOT overridable: it protects an advance that
  -- already exists from being inflated after the fact, which no issuance decision
  -- needs. To issue more, create a new advance or a top-up.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.principal > OLD.principal THEN
      RAISE EXCEPTION 'ADVANCE_PRINCIPAL_INFLATION_BLOCKED: principal cannot be increased after creation (old=%, new=%)',
        OLD.principal, NEW.principal
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Rule 2: on INSERT, sanity bounds. A non-positive principal is never valid,
  -- override or not.
  IF NEW.principal IS NULL OR NEW.principal <= 0 THEN
    RAISE EXCEPTION 'ADVANCE_PRINCIPAL_INVALID: principal must be > 0 (got %)', NEW.principal
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(NEW.gate_override, false) THEN RETURN NEW; END IF;

  IF NEW.principal < 1000 THEN
    RAISE EXCEPTION 'ADVANCE_PRINCIPAL_TOO_SMALL: principal % UGX is below the 1,000 UGX minimum (prevents fat-finger/test taps)',
      NEW.principal
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 3: monthly_rate cannot exceed the 33% standard
  IF NEW.monthly_rate > 0.33 THEN
    RAISE EXCEPTION 'ADVANCE_RATE_ABOVE_STANDARD: monthly_rate % exceeds the 33%% standard', NEW.monthly_rate
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;
