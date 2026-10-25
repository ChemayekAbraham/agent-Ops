-- =============================================================================
-- Migration: 20261026000000_staff_assistant_read_tools_batch1.sql
-- Purpose:   Zoe (My Space AI Assistant) read-only tool RPCs — Batch 1:
--              - Group A: Every Staff Member (My Space own items, Questions 1–9)
--              - Group B: Tenant Ops (Questions 10–17)
--              - Group C: Landlord Ops (Questions 18–22)
--
-- Safety & Invariants:
--   1. Every assistant_staff_* function is STABLE, SECURITY DEFINER,
--      and SET search_path = public.
--   2. Zero user/agent/tenant/account/owner identity parameters; caller
--      identity is always resolved from auth.uid().
--   3. Every function begins with public.staff_assistant_has_access() plus
--      the group/tool role check and raises ERRCODE = '42501' if not allowed.
--   4. Every figure comes from the official existing report function or
--      caller-scoped My Space table without recalculating money or counts.
--   5. Returns at most 200 rows plus explicit 'source' and 'period' fields.
--   6. Masks phone numbers and national IDs for roles that do not see them
--      on their normal screens via staff_assistant_sanitize_jsonb().
--   7. Grants EXECUTE to authenticated only (revoked from PUBLIC, anon, service_role).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Masking & JSONB Sanitization Helpers (staff_assistant_* namespace)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_assistant_can_view_pii(
  p_scope text DEFAULT 'ops'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN p_scope = 'self' THEN true
    WHEN p_scope = 'tenant_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['tenant_ops', 'operations', 'coo', 'super_admin']
      )
    WHEN p_scope = 'landlord_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['landlord_ops', 'operations', 'coo', 'super_admin']
      )
    ELSE
      public._has_enabled_role(
        auth.uid(),
        ARRAY['tenant_ops', 'landlord_ops', 'agent_ops', 'operations', 'coo', 'super_admin']
      )
  END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_view_pii(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_view_pii(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_mask_phone(
  p_phone text,
  p_allow_full boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text := btrim(coalesce(p_phone, ''));
  v_digits text;
BEGIN
  IF v_clean = '' THEN
    RETURN NULL;
  END IF;

  IF p_allow_full IS TRUE THEN
    RETURN public.assistant_clean_phone(v_clean);
  END IF;

  v_digits := regexp_replace(v_clean, '[^0-9]', '', 'g');
  IF length(v_digits) < 3 THEN
    RETURN '+256 7•• ••• •••';
  END IF;

  RETURN '+256 7•• ••• ' || right(v_digits, 3);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_mask_phone(text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_mask_phone(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_mask_nin(
  p_nin text,
  p_allow_full boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text := regexp_replace(btrim(coalesce(p_nin, '')), '[^A-Za-z0-9]', '', 'g');
BEGIN
  IF v_clean = '' THEN
    RETURN NULL;
  END IF;

  IF p_allow_full IS TRUE THEN
    RETURN left(v_clean, 32);
  END IF;

  IF length(v_clean) <= 3 THEN
    RETURN '•••••••••••';
  END IF;

  RETURN '•••••••••••' || right(v_clean, 3);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_mask_nin(text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_mask_nin(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_sanitize_jsonb(
  p_data jsonb,
  p_allow_phones boolean DEFAULT false,
  p_max_rows integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap integer := LEAST(GREATEST(coalesce(p_max_rows, 200), 1), 200);
  v_kind text;
  v_out jsonb;
BEGIN
  IF p_data IS NULL THEN
    RETURN NULL;
  END IF;

  v_kind := jsonb_typeof(p_data);

  IF v_kind = 'array' THEN
    SELECT coalesce(
      jsonb_agg(
        public.staff_assistant_sanitize_jsonb(elem.val, p_allow_phones, v_cap)
        ORDER BY elem.ord
      ),
      '[]'::jsonb
    )
    INTO v_out
    FROM (
      SELECT val, ord
      FROM jsonb_array_elements(p_data) WITH ORDINALITY AS t(val, ord)
      ORDER BY ord
      LIMIT v_cap
    ) elem;
    RETURN v_out;
  ELSIF v_kind = 'object' THEN
    SELECT coalesce(
      jsonb_object_agg(
        kv.key,
        CASE
          WHEN kv.key ~* '(^|_)(phone|msisdn|mobile|tel)($|_)'
               AND jsonb_typeof(kv.value) = 'string'
            THEN to_jsonb(public.staff_assistant_mask_phone(kv.value #>> '{}', p_allow_phones))
          WHEN kv.key ~* '(^|_)(nin|national_id)($|_)'
               AND jsonb_typeof(kv.value) = 'string'
            THEN to_jsonb(public.staff_assistant_mask_nin(kv.value #>> '{}', false))
          ELSE public.staff_assistant_sanitize_jsonb(kv.value, p_allow_phones, v_cap)
        END
      ),
      '{}'::jsonb
    )
    INTO v_out
    FROM jsonb_each(p_data) AS kv(key, value)
    WHERE kv.key !~* '^(password|pin_hash|otp|secret|token|device_fp|id_image_hash)';
    RETURN v_out;
  ELSE
    RETURN p_data;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_sanitize_jsonb(jsonb, boolean, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_sanitize_jsonb(jsonb, boolean, integer) TO authenticated;

-- =============================================================================
-- GROUP A — EVERY STAFF MEMBER (MY SPACE PERSONAL SCOPE, QUESTIONS 1–9)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Q1. assistant_staff_my_profile()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_profile()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_profile record;
  v_hr record;
  v_assignments jsonb;
  v_roles jsonb;
  v_permissions jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  v_staff_id := public.hr_my_staff_id();

  SELECT
    p.id,
    public.assistant_clean_text(p.full_name, 120) AS full_name,
    public.assistant_clean_phone(p.phone) AS phone,
    public.assistant_real_email(btrim(p.email)) AS registered_email,
    p.verified
  INTO v_profile
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_staff_id IS NOT NULL THEN
    SELECT
      hs.id,
      hs.staff_ref,
      hs.active,
      hs.created_at,
      hs.ended_on
    INTO v_hr
    FROM public.hr_staff hs
    WHERE hs.id = v_staff_id;

    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'assignment_id', a.id,
          'department_key', d.key,
          'department_name', d.name,
          'position_key', pos.key,
          'position_title', pos.title,
          'is_primary', a.is_primary,
          'started_on', a.started_on,
          'ended_on', a.ended_on
        )
        ORDER BY a.is_primary DESC, a.started_on DESC
      ),
      '[]'::jsonb
    )
    INTO v_assignments
    FROM (
      SELECT ha.*
      FROM public.hr_assignments ha
      WHERE ha.staff_id = v_staff_id
        AND ha.ended_on IS NULL
      ORDER BY ha.is_primary DESC, ha.started_on DESC
      LIMIT 200
    ) a
    LEFT JOIN public.hr_departments d ON d.id = a.department_id
    LEFT JOIN public.hr_positions pos ON pos.id = a.position_id;
  ELSE
    v_assignments := '[]'::jsonb;
  END IF;

  SELECT coalesce(
    jsonb_agg(ur.role::text ORDER BY ur.role::text),
    '[]'::jsonb
  )
  INTO v_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_uid
    AND ur.enabled IS TRUE;

  SELECT coalesce(
    jsonb_agg(sp.permitted_dashboard ORDER BY sp.permitted_dashboard),
    '[]'::jsonb
  )
  INTO v_permissions
  FROM public.staff_permissions sp
  WHERE sp.user_id = v_uid
    AND sp.revoked_at IS NULL;

  RETURN jsonb_build_object(
    'source', 'hr_my_staff_id + profiles + hr_staff + hr_assignments + user_roles + staff_permissions',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'data', jsonb_build_object(
      'full_name', v_profile.full_name,
      'phone', v_profile.phone,
      'registered_email', v_profile.registered_email,
      'has_registered_email', (v_profile.registered_email IS NOT NULL),
      'verified', coalesce(v_profile.verified, false),
      'staff_id', v_staff_id,
      'staff_ref', v_hr.staff_ref,
      'staff_active', coalesce(v_hr.active, false),
      'assignments', v_assignments,
      'enabled_roles', v_roles,
      'permitted_dashboards', v_permissions
    ),
    'rows', v_assignments
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_profile() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_profile() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q2. assistant_staff_my_payslips()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_payslips()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ps.id,
        'period_code', ps.period_code,
        'pay_date', ps.pay_date,
        'gross', ps.gross,
        'paye', ps.paye,
        'nssf_employee', ps.nssf_employee,
        'other_deductions', ps.other_deductions,
        'net', ps.net,
        'run_status', ps.run_status
      )
      ORDER BY ps.pay_date DESC NULLS LAST, ps.period_code DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
    FROM public.hr_pay_my_payslips()
    ORDER BY pay_date DESC NULLS LAST, period_code DESC
    LIMIT 200
  ) ps;

  RETURN jsonb_build_object(
    'source', 'hr_pay_my_payslips',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'data', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_payslips() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_payslips() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q3. assistant_staff_my_tasks(p_status text DEFAULT NULL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_tasks(
  p_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  v_staff_id := public.hr_my_staff_id();

  IF v_staff_id IS NULL THEN
    v_rows := '[]'::jsonb;
  ELSE
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'ref', t.ref,
          'title', public.assistant_clean_text(t.title, 200),
          'department_name', d.name,
          'priority', t.priority::text,
          'status', t.status::text,
          'origin', t.origin,
          'due_at', t.due_at,
          'is_overdue', (t.due_at IS NOT NULL AND t.due_at < now() AND t.status::text NOT IN ('completed', 'cancelled')),
          'created_at', t.created_at,
          'started_at', t.started_at,
          'submitted_at', t.submitted_at,
          'completed_at', t.completed_at
        )
        ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
      ),
      '[]'::jsonb
    )
    INTO v_rows
    FROM (
      SELECT tk.*
      FROM public.hr_tasks tk
      WHERE tk.assignee_staff_id = v_staff_id
        AND (v_status IS NULL OR lower(tk.status::text) = v_status)
      ORDER BY tk.due_at ASC NULLS LAST, tk.created_at DESC
      LIMIT 200
    ) t
    LEFT JOIN public.hr_departments d ON d.id = t.department_id;
  END IF;

  RETURN jsonb_build_object(
    'source', 'hr_my_staff_id + hr_tasks',
    'period', jsonb_build_object('as_of', v_today, 'status_filter', v_status),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'data', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_tasks(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_tasks(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q4. assistant_staff_my_tickets()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_tickets()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_ticket_ids uuid[];
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  v_staff_id := public.hr_my_staff_id();

  SELECT coalesce(array_agg(sub.id), ARRAY[]::uuid[])
  INTO v_ticket_ids
  FROM (
    SELECT t.id
    FROM public.hr_tickets t
    LEFT JOIN public.hr_tasks tk ON tk.id = t.task_id
    WHERE t.raised_by = v_uid
       OR (v_staff_id IS NOT NULL AND t.raised_by = v_staff_id)
       OR (v_staff_id IS NOT NULL AND tk.assignee_staff_id = v_staff_id)
    ORDER BY t.raised_at DESC NULLS LAST
    LIMIT 200
  ) sub;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'ref', t.ref,
        'title', public.assistant_clean_text(t.title, 200),
        'severity', t.severity::text,
        'origin', t.origin::text,
        'raised_at', t.raised_at,
        'raised_by_name', tp.raised_by_name,
        'assignee_name', tp.assignee_name,
        'closed_by_name', tp.closed_by_name,
        'task_id', t.task_id,
        'task_title', tp.task_title,
        'closed_no_task_at', t.closed_no_task_at,
        'resolution_summary', public.assistant_clean_text(t.resolution_summary, 240)
      )
      ORDER BY t.raised_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.hr_tickets t
  LEFT JOIN public.hr_ticket_people(v_ticket_ids) tp ON tp.ticket_id = t.id
  WHERE t.id = ANY(v_ticket_ids);

  RETURN jsonb_build_object(
    'source', 'hr_tickets + hr_ticket_people',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'data', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_tickets() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_tickets() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q5. assistant_staff_my_requisitions()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_requisitions()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_reqs jsonb;
  v_notices jsonb;
  v_usage_notices jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'requisition_code', r.requisition_code,
        'title', public.assistant_clean_text(r.title, 200),
        'department_key', r.department_key,
        'category', r.category,
        'request_kind', r.request_kind,
        'amount', r.amount,
        'approved_amount', r.approved_amount,
        'currency', r.currency,
        'stage', r.stage,
        'current_approver_role', r.current_approver_role,
        'wallet_credit_status', r.wallet_credit_status,
        'needed_by', r.needed_by,
        'created_at', r.created_at,
        'decided_at', r.decided_at
      )
      ORDER BY r.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_reqs
  FROM (
    SELECT sr.*
    FROM public.staff_requisitions sr
    WHERE sr.requester_id = v_uid
    ORDER BY sr.created_at DESC
    LIMIT 200
  ) r;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', n.id,
        'requisition_id', n.requisition_id,
        'requisition_code', n.requisition_code,
        'kind', n.kind,
        'from_stage', n.from_stage,
        'to_stage', n.to_stage,
        'amount_before', n.amount_before,
        'amount_after', n.amount_after,
        'actor_name', n.actor_name,
        'title', public.assistant_clean_text(n.title, 200),
        'created_at', n.created_at
      )
      ORDER BY n.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_notices
  FROM (
    SELECT *
    FROM public.staff_requisition_my_notices()
    ORDER BY created_at DESC
    LIMIT 200
  ) n;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'requisition_id', u.requisition_id,
        'requisition_code', u.requisition_code,
        'title', public.assistant_clean_text(u.title, 200),
        'amount', u.amount,
        'approved_amount', u.approved_amount,
        'category', u.category,
        'cfo_decided_at', u.cfo_decided_at,
        'grace_ends_at', u.grace_ends_at,
        'deferral_count', u.deferral_count,
        'max_deferrals', u.max_deferrals,
        'mandatory', u.mandatory,
        'acknowledged', u.acknowledged
      )
      ORDER BY u.cfo_decided_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO v_usage_notices
  FROM (
    SELECT *
    FROM public.get_my_usage_report_notices()
    LIMIT 200
  ) u;

  RETURN jsonb_build_object(
    'source', 'staff_requisitions + staff_requisition_my_notices + get_my_usage_report_notices',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_reqs),
    'rows', v_reqs,
    'data', jsonb_build_object(
      'requisitions', v_reqs,
      'notices', v_notices,
      'usage_report_notices', v_usage_notices
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_requisitions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_requisitions() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q6. assistant_staff_my_advances()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_advances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  v_staff_id := public.hr_my_staff_id();

  IF v_staff_id IS NULL THEN
    v_rows := '[]'::jsonb;
  ELSE
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'principal', a.principal,
          'recovered', coalesce(rt.recovered, 0),
          'outstanding', GREATEST(coalesce(a.principal, 0) - coalesce(rt.recovered, 0), 0),
          'currency', a.currency,
          'purpose', public.assistant_clean_text(a.purpose, 200),
          'recovery_mode', a.recovery_mode,
          'recovery_value', a.recovery_value,
          'recovery_months', a.recovery_months,
          'first_recovery_on', a.first_recovery_on,
          'status', a.status,
          'requested_at', a.requested_at,
          'disbursed_at', a.disbursed_at
        )
        ORDER BY a.requested_at DESC NULLS LAST, a.created_at DESC
      ),
      '[]'::jsonb
    )
    INTO v_rows
    FROM (
      SELECT pa.*
      FROM public.hr_pay_advances pa
      WHERE pa.staff_id = v_staff_id
      ORDER BY pa.requested_at DESC NULLS LAST, pa.created_at DESC
      LIMIT 200
    ) a
    LEFT JOIN public.hr_pay_advance_recovered_totals() rt ON rt.advance_id = a.id;
  END IF;

  RETURN jsonb_build_object(
    'source', 'hr_pay_advances + hr_pay_advance_recovered_totals',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'data', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_advances() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_advances() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q7. assistant_staff_my_pending_concerns()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_pending_concerns()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'concern_id', c.concern_id,
        'title', public.assistant_clean_text(c.title, 200),
        'context', public.assistant_clean_text(c.context, 240),
        'priority', c.priority,
        'status', c.status,
        'due_at', c.due_at,
        'caller_name', c.caller_name,
        'subject_type', c.subject_type,
        'forwarded_by_name', c.forwarded_by_name,
        'added_by_name', c.added_by_name,
        'reviewer_role', c.reviewer_role,
        'notified_at', c.notified_at,
        'assigned_at', c.assigned_at,
        'participant_count', c.participant_count
      )
      ORDER BY c.due_at ASC NULLS LAST, c.assigned_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
    FROM public.cc_my_pending_concerns()
    ORDER BY due_at ASC NULLS LAST, assigned_at DESC NULLS LAST
    LIMIT 200
  ) c;

  RETURN jsonb_build_object(
    'source', 'cc_my_pending_concerns',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'data', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_pending_concerns() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_pending_concerns() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q8. assistant_staff_my_canteen(p_service_date date DEFAULT NULL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_canteen(
  p_service_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_day date := coalesce(p_service_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_menu jsonb;
  v_orders jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() OR NOT public.food_can_use_canteen() THEN
    RAISE EXCEPTION 'Not authorized: canteen staff access required'
      USING ERRCODE = '42501';
  END IF;

  v_menu := public.food_menu_for_day(v_day);

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', fo.id,
        'order_reference', fo.order_reference,
        'service_date', fo.service_date,
        'total_ugx', fo.total_ugx,
        'payment_status', fo.payment_status,
        'fulfilment_status', fo.fulfilment_status,
        'payment_mode', fo.payment_mode,
        'placed_at', fo.placed_at,
        'paid_at', fo.paid_at,
        'received_at', fo.received_at
      )
      ORDER BY fo.service_date DESC, fo.placed_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_orders
  FROM (
    SELECT o.*
    FROM public.food_orders o
    WHERE o.employee_id = v_uid
    ORDER BY o.service_date DESC, o.placed_at DESC
    LIMIT 200
  ) fo;

  RETURN jsonb_build_object(
    'source', 'food_menu_for_day + food_orders',
    'period', jsonb_build_object('service_date', v_day),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_orders),
    'rows', v_orders,
    'data', jsonb_build_object(
      'menu', v_menu,
      'my_orders', v_orders
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_canteen(date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_canteen(date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q9. assistant_staff_my_wallet()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_wallet()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_wallet record;
  v_data jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    w.id,
    coalesce(w.balance, 0) AS balance,
    coalesce(w.withdrawable_balance, 0) AS withdrawable_balance,
    coalesce(w.float_balance, 0) AS float_balance,
    coalesce(w.locked_balance, 0) AS locked_balance,
    coalesce(w.advance_balance, 0) AS advance_balance,
    coalesce(w.currency, 'UGX') AS currency,
    w.updated_at
  INTO v_wallet
  FROM public.wallets w
  WHERE w.user_id = v_uid;

  v_data := jsonb_build_object(
    'has_wallet', (v_wallet.id IS NOT NULL),
    'balance', coalesce(v_wallet.balance, 0),
    'withdrawable_balance', coalesce(v_wallet.withdrawable_balance, 0),
    'float_balance', coalesce(v_wallet.float_balance, 0),
    'locked_balance', coalesce(v_wallet.locked_balance, 0),
    'advance_balance', coalesce(v_wallet.advance_balance, 0),
    'currency', coalesce(v_wallet.currency, 'UGX'),
    'updated_at', v_wallet.updated_at
  );

  RETURN jsonb_build_object(
    'source', 'wallets',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'row_count', CASE WHEN v_wallet.id IS NOT NULL THEN 1 ELSE 0 END,
    'rows', jsonb_build_array(v_data),
    'data', v_data
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_wallet() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_wallet() TO authenticated;

-- =============================================================================
-- GROUP B — TENANT OPS (QUESTIONS 10–17)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Q10. assistant_staff_tops_first_seven_summary(p_from, p_to, p_frequency)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_first_seven_summary(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_frequency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, v_to - 30);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');
  v_raw := public.am_new_tenant_first7_summary_v2(v_from, v_to, p_frequency, NULL);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200);

  RETURN jsonb_build_object(
    'source', 'am_new_tenant_first7_summary_v2',
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'frequency', p_frequency),
    'row_limit', 200,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'per_day', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_first_seven_summary(date, date, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_first_seven_summary(date, date, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q11. assistant_staff_tops_arrears_ageing(p_as_at, p_bucket, p_limit, p_offset, p_dir)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_arrears_ageing(
  p_as_at date DEFAULT NULL,
  p_bucket text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_as_at date := coalesce(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');
  v_raw := public.tops_arrears_ageing_amclock(v_as_at, p_bucket, v_limit, v_offset, p_dir);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200);

  RETURN jsonb_build_object(
    'source', 'tops_arrears_ageing_amclock',
    'period', jsonb_build_object('as_of', v_as_at, 'bucket', p_bucket),
    'row_limit', v_limit,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'rows', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q12. assistant_staff_tops_landlord_not_paid(p_as_at, p_limit, p_offset)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_landlord_not_paid(
  p_as_at date DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_as_at date := coalesce(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 200), 1), 200);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_allow_phones boolean;
  v_summary record;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');

  SELECT *
  INTO v_summary
  FROM public.tops_landlord_not_paid_summary_amclock()
  LIMIT 1;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rent_request_id', u.rent_request_id,
        'bucket', u.bucket,
        'tenant_name', u.tenant_name,
        'tenant_phone', public.staff_assistant_mask_phone(u.tenant_phone, v_allow_phones),
        'agent_name', u.agent_name,
        'funded_amount', u.funded_amount,
        'total_repayment', u.total_repayment,
        'repaid', u.repaid,
        'still_owed', u.still_owed,
        'funded_on', u.funded_on,
        'days_since_funding', u.days_since_funding,
        'payout_kind', u.payout_kind,
        'payout_paid_amount', u.payout_paid_amount,
        'payout_allocated_amount', u.payout_allocated_amount,
        'pipeline_status', u.pipeline_status,
        'total_rows', u.total_rows
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
    FROM public.am_uncovered_plans(v_as_at, v_limit, v_offset)
    LIMIT v_limit
  ) u;

  RETURN jsonb_build_object(
    'source', 'tops_landlord_not_paid_summary_amclock + am_uncovered_plans',
    'period', jsonb_build_object('as_of', coalesce(v_summary.as_of, v_as_at)),
    'row_limit', v_limit,
    'row_count', jsonb_array_length(v_rows),
    'data', jsonb_build_object(
      'summary', jsonb_build_object(
        'tenant_paying_no_landlord', coalesce(v_summary.tenant_paying_no_landlord, 0),
        'awaiting_landlord', coalesce(v_summary.awaiting_landlord, 0),
        'total_plans', coalesce(v_summary.total_plans, 0),
        'as_of', coalesce(v_summary.as_of, v_as_at)
      ),
      'rows', v_rows
    ),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_landlord_not_paid(date, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_landlord_not_paid(date, integer, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q13. assistant_staff_tops_tenant_classification()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_tenant_classification()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_raw := public.tops_tenant_classification_summary();
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, public.staff_assistant_can_view_pii('tenant_ops'), 200);

  RETURN jsonb_build_object(
    'source', 'tops_tenant_classification_summary',
    'period', jsonb_build_object('as_of', coalesce((v_clean ->> 'as_of')::date, v_today)),
    'row_limit', 200,
    'data', v_clean,
    'rows', jsonb_build_array(v_clean)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_tenant_classification() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_tenant_classification() TO authenticated;

-- -----------------------------------------------------------------------------
-- Q14. assistant_staff_tops_smartphone_usage(p_from, p_to)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_smartphone_usage(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := coalesce(p_from, v_to - 30);
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_raw := public.tops_smartphone_usage(v_from, v_to);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, public.staff_assistant_can_view_pii('tenant_ops'), 200);

  RETURN jsonb_build_object(
    'source', 'tops_smartphone_usage',
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'row_limit', 200,
    'data', v_clean,
    'rows', jsonb_build_array(v_clean)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_smartphone_usage(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_smartphone_usage(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q15. assistant_staff_tops_weekly_performance(p_anchor)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_weekly_performance(
  p_anchor date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_anchor date := coalesce(p_anchor, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(v_uid, ARRAY['tenant_ops','operations','coo','ceo','cto','manager','super_admin'])
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_raw := public.get_tenant_ops_weekly_performance_amclock(v_anchor);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, public.staff_assistant_can_view_pii('tenant_ops'), 200);

  RETURN jsonb_build_object(
    'source', 'get_tenant_ops_weekly_performance_amclock',
    'period', jsonb_build_object('anchor', v_anchor),
    'row_limit', 200,
    'data', v_clean,
    'rows', jsonb_build_array(v_clean)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_weekly_performance(date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_weekly_performance(date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q16. assistant_staff_tops_no_payment_report(p_min_days)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_no_payment_report(
  p_min_days integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_min_days integer := LEAST(GREATEST(coalesce(p_min_days, 20), 1), 365);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(v_uid, ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin'])
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');
  v_raw := public.get_tenant_ops_no_payment_report_v2(v_min_days, NULL);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200);

  RETURN jsonb_build_object(
    'source', 'get_tenant_ops_no_payment_report_v2',
    'period', jsonb_build_object('as_of', v_today, 'min_days', v_min_days),
    'row_limit', 200,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'rows', v_clean -> 'items', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_no_payment_report(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_no_payment_report(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q17. assistant_staff_tops_rent_request_lifetime()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_rent_request_lifetime()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(v_uid, ARRAY['tenant_ops','operations','coo','ceo','cto','manager','super_admin'])
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_raw := public.tenant_ops_rent_request_lifetime();
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, public.staff_assistant_can_view_pii('tenant_ops'), 200);

  RETURN jsonb_build_object(
    'source', 'tenant_ops_rent_request_lifetime',
    'period', jsonb_build_object('as_of', v_today),
    'row_limit', 200,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'stages', jsonb_build_array(v_clean))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_rent_request_lifetime() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_rent_request_lifetime() TO authenticated;

-- =============================================================================
-- GROUP C — LANDLORD OPS (QUESTIONS 18–22)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Q18. assistant_staff_lops_home_range(p_from, p_to)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_home_range(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, v_to - 30);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := (v_to::timestamp AT TIME ZONE 'Africa/Kampala');
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops','coo','cfo','ceo','manager','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Landlord Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_raw := public.ops_landlord_ops_home_range(v_start, v_end);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, public.staff_assistant_can_view_pii('landlord_ops'), 200);

  RETURN jsonb_build_object(
    'source', 'ops_landlord_ops_home_range',
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'row_limit', 200,
    'data', v_clean,
    'rows', jsonb_build_array(v_clean)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_home_range(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_home_range(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q19. assistant_staff_lops_paid_lists(p_tab, p_search, p_limit, p_offset)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_paid_lists(
  p_tab text DEFAULT 'paid_repaying',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_tab text := coalesce(nullif(btrim(p_tab), ''), 'paid_repaying');
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops','coo','cfo','ceo','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Landlord Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('landlord_ops');
  v_raw := public.landlord_ops_paid_lists(v_tab, p_search, v_limit, v_offset);
  v_clean := public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200);

  RETURN jsonb_build_object(
    'source', 'landlord_ops_paid_lists',
    'period', jsonb_build_object('as_of', v_today, 'tab', v_tab),
    'row_limit', v_limit,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'rows', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_paid_lists(text, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_paid_lists(text, text, integer, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q20. assistant_staff_lops_principal_comparison(p_from, p_to)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_principal_comparison(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_allow_phones boolean;
  v_comparison jsonb;
  v_float jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Landlord Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('landlord_ops');
  v_comparison := public.staff_assistant_sanitize_jsonb(
    public.landlord_ops_principal_comparison(p_from, v_to),
    v_allow_phones,
    200
  );
  v_float := public.staff_assistant_sanitize_jsonb(
    public.landlord_ops_float_overview(),
    v_allow_phones,
    200
  );

  RETURN jsonb_build_object(
    'source', 'landlord_ops_principal_comparison + landlord_ops_float_overview',
    'period', jsonb_build_object('from', p_from, 'to', v_to),
    'row_limit', 200,
    'data', jsonb_build_object(
      'principal_comparison', v_comparison,
      'float_overview', v_float
    ),
    'rows', coalesce(v_comparison -> 'trend', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_principal_comparison(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_principal_comparison(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q21. assistant_staff_lops_calling_summary(p_from, p_to, p_week_start)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_calling_summary(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_week_start date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, v_to - 6);
  v_allow_phones boolean;
  v_daily jsonb;
  v_weekly jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._landlord_cc_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops','operations','coo','ceo','cfo','cto','manager','hr','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Landlord Calling Center access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('landlord_ops');

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kampala_day', d.kampala_day,
        'staff_id', d.staff_id,
        'staff_name', d.staff_name,
        'total_calls', d.total_calls,
        'engaged_calls', d.engaged_calls,
        'reached_calls', d.reached_calls,
        'unreachable_calls', d.unreachable_calls,
        'callback_calls', d.callback_calls,
        'made_calls', d.made_calls,
        'received_calls', d.received_calls
      )
      ORDER BY d.kampala_day DESC, d.total_calls DESC
    ),
    '[]'::jsonb
  )
  INTO v_daily
  FROM (
    SELECT *
    FROM public.landlord_cc_daily_summary(v_from, v_to)
    ORDER BY kampala_day DESC, total_calls DESC
    LIMIT 200
  ) d;

  v_weekly := public.staff_assistant_sanitize_jsonb(
    public.landlord_cc_weekly_report(p_week_start),
    v_allow_phones,
    200
  );

  RETURN jsonb_build_object(
    'source', 'landlord_cc_daily_summary + landlord_cc_weekly_report',
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'week_start', p_week_start),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_daily),
    'data', jsonb_build_object(
      'daily_summary', v_daily,
      'weekly_report', v_weekly
    ),
    'rows', v_daily
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_calling_summary(date, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_calling_summary(date, date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Q22. assistant_staff_lops_calling_coverage(p_as_at)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_calling_coverage(
  p_as_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_as_at timestamptz := coalesce(p_as_at, now());
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._landlord_cc_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops','operations','coo','ceo','cfo','cto','manager','hr','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Landlord Calling Center access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'region', c.region,
        'district', c.district,
        'registry_total', c.registry_total,
        'ever_reached', c.ever_reached,
        'reached_this_round', c.reached_this_round,
        'reached_this_month', c.reached_this_month,
        'never_called', c.never_called,
        'called_but_unreached', c.called_but_unreached,
        'needs_review_count', c.needs_review_count,
        'active_rent_plans_count', c.active_rent_plans_count
      )
      ORDER BY c.registry_total DESC, c.region ASC, c.district ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
    FROM public.landlord_cc_coverage(v_as_at)
    ORDER BY registry_total DESC, region ASC, district ASC
    LIMIT 200
  ) c;

  RETURN jsonb_build_object(
    'source', 'landlord_cc_coverage',
    'period', jsonb_build_object('as_of', (v_as_at AT TIME ZONE 'Africa/Kampala')::date),
    'row_limit', 200,
    'row_count', jsonb_array_length(v_rows),
    'data', v_rows,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_calling_coverage(timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_calling_coverage(timestamptz) TO authenticated;

COMMIT;
