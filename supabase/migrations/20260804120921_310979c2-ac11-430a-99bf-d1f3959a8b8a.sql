-- ============================================================
-- Error Correction Governance (new tables only; no historical data touched)
-- ============================================================

CREATE TABLE public.error_correction_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  high_value_threshold numeric NOT NULL DEFAULT 100000,
  cfo_approval_threshold numeric NOT NULL DEFAULT 500000,
  dual_approval_threshold numeric NOT NULL DEFAULT 2000000,
  alert_threshold numeric NOT NULL DEFAULT 100000,
  velocity_window_minutes integer NOT NULL DEFAULT 60,
  velocity_max_operations integer NOT NULL DEFAULT 3,
  velocity_max_distinct_users integer NOT NULL DEFAULT 3,
  require_commission_ack boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.error_correction_config TO authenticated;
GRANT ALL ON public.error_correction_config TO service_role;
ALTER TABLE public.error_correction_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and exec can read error correction config"
ON public.error_correction_config FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'operations')
);

CREATE POLICY "Executives can update error correction config"
ON public.error_correction_config FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

INSERT INTO public.error_correction_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- ── Approval requests ───────────────────────────────────────
CREATE TABLE public.error_correction_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL,
  requester_roles text[] NOT NULL DEFAULT '{}',
  target_user_id uuid NOT NULL,
  target_name text,
  amount numeric NOT NULL CHECK (amount > 0),
  bucket text NOT NULL CHECK (bucket IN ('withdrawable','float')),
  reason_code text NOT NULL,
  reason_detail text NOT NULL,
  business_justification text NOT NULL,
  reference_number text NOT NULL,
  related_transaction_id text,
  withdrawable_before numeric NOT NULL DEFAULT 0,
  float_before numeric NOT NULL DEFAULT 0,
  commission_component numeric NOT NULL DEFAULT 0,
  required_approvals integer NOT NULL DEFAULT 1,
  approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','executed','expired')),
  decided_at timestamptz,
  executed_at timestamptz,
  executed_ledger_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.error_correction_approvals TO authenticated;
GRANT ALL ON public.error_correction_approvals TO service_role;
ALTER TABLE public.error_correction_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and exec can read correction approvals"
ON public.error_correction_approvals FOR SELECT TO authenticated
USING (
  requested_by = auth.uid()
  OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'operations')
);

CREATE INDEX idx_ec_approvals_status ON public.error_correction_approvals(status, created_at DESC);

-- ── Audit register ──────────────────────────────────────────
CREATE TABLE public.error_correction_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL,
  operator_name text,
  operator_roles text[] NOT NULL DEFAULT '{}',
  target_user_id uuid NOT NULL,
  target_name text,
  target_phone text,
  amount numeric NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('withdrawable','float')),
  reason_code text NOT NULL,
  reason_detail text NOT NULL,
  business_justification text NOT NULL,
  reference_number text NOT NULL,
  related_transaction_id text,
  withdrawable_before numeric NOT NULL DEFAULT 0,
  withdrawable_after numeric NOT NULL DEFAULT 0,
  float_before numeric NOT NULL DEFAULT 0,
  float_after numeric NOT NULL DEFAULT 0,
  commission_component numeric NOT NULL DEFAULT 0,
  commission_acknowledged boolean NOT NULL DEFAULT false,
  high_value_confirmed boolean NOT NULL DEFAULT false,
  approval_id uuid REFERENCES public.error_correction_approvals(id) ON DELETE SET NULL,
  ledger_group_id uuid,
  ledger_reference_id text,
  transaction_group_category text,
  platform_destination text,
  status text NOT NULL DEFAULT 'posted'
    CHECK (status IN ('posted','failed','reversed')),
  client_ip text,
  user_agent text,
  device text,
  browser text,
  session_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.error_correction_audit TO authenticated;
GRANT ALL ON public.error_correction_audit TO service_role;
ALTER TABLE public.error_correction_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and exec can read error correction audit"
ON public.error_correction_audit FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'operations')
);

CREATE INDEX idx_ec_audit_created ON public.error_correction_audit(created_at DESC);
CREATE INDEX idx_ec_audit_operator ON public.error_correction_audit(operator_id, created_at DESC);
CREATE INDEX idx_ec_audit_target ON public.error_correction_audit(target_user_id, created_at DESC);

-- ── High-risk alerts ────────────────────────────────────────
CREATE TABLE public.error_correction_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'high' CHECK (severity IN ('low','medium','high','critical')),
  operator_id uuid,
  operator_name text,
  target_user_id uuid,
  target_name text,
  amount numeric,
  bucket text,
  reason_code text,
  reference_number text,
  transaction_group_id uuid,
  audit_id uuid REFERENCES public.error_correction_audit(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.error_correction_alerts TO authenticated;
GRANT ALL ON public.error_correction_alerts TO service_role;
ALTER TABLE public.error_correction_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and exec can read error correction alerts"
ON public.error_correction_alerts FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'operations')
);

CREATE INDEX idx_ec_alerts_created ON public.error_correction_alerts(created_at DESC);

-- ── updated_at triggers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_error_correction_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_touch_ec_config BEFORE UPDATE ON public.error_correction_config
FOR EACH ROW EXECUTE FUNCTION public.touch_error_correction_updated_at();

CREATE TRIGGER trg_touch_ec_approvals BEFORE UPDATE ON public.error_correction_approvals
FOR EACH ROW EXECUTE FUNCTION public.touch_error_correction_updated_at();

-- ── Helper: is the caller a finance/exec reviewer? ───────────
CREATE OR REPLACE FUNCTION public.is_error_correction_reviewer(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('cfo','cto','ceo','coo','manager','super_admin')
  );
$$;

-- ── Approve / reject an approval request ────────────────────
CREATE OR REPLACE FUNCTION public.decide_error_correction_approval(
  p_approval_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.error_correction_approvals;
  v_roles text[];
  v_approvals jsonb;
  v_count integer;
  v_status text;
BEGIN
  IF NOT public.is_error_correction_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Only finance and executive roles can decide error corrections';
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'Decision must be approve or reject';
  END IF;
  IF coalesce(length(trim(p_note)), 0) < 10 AND p_decision = 'reject' THEN
    RAISE EXCEPTION 'A rejection note of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row FROM public.error_correction_approvals
  WHERE id = p_approval_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This request is already %', v_row.status;
  END IF;
  IF v_row.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot approve your own error correction';
  END IF;
  IF v_row.approvals @> jsonb_build_array(jsonb_build_object('approver_id', auth.uid()::text)) THEN
    RAISE EXCEPTION 'You have already decided on this request';
  END IF;

  SELECT array_agg(role::text) INTO v_roles FROM public.user_roles WHERE user_id = auth.uid();

  IF p_decision = 'reject' THEN
    UPDATE public.error_correction_approvals
    SET status = 'rejected',
        decided_at = now(),
        approvals = approvals || jsonb_build_array(jsonb_build_object(
          'approver_id', auth.uid()::text, 'roles', coalesce(v_roles, '{}'),
          'decision', 'reject', 'note', p_note, 'at', now()
        ))
    WHERE id = p_approval_id;
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  v_approvals := v_row.approvals || jsonb_build_array(jsonb_build_object(
    'approver_id', auth.uid()::text, 'roles', coalesce(v_roles, '{}'),
    'decision', 'approve', 'note', p_note, 'at', now()
  ));
  SELECT count(*) INTO v_count
  FROM jsonb_array_elements(v_approvals) e
  WHERE e->>'decision' = 'approve';

  v_status := CASE WHEN v_count >= v_row.required_approvals THEN 'approved' ELSE 'pending' END;

  UPDATE public.error_correction_approvals
  SET approvals = v_approvals,
      status = v_status,
      decided_at = CASE WHEN v_status = 'approved' THEN now() ELSE decided_at END
  WHERE id = p_approval_id;

  RETURN jsonb_build_object('status', v_status, 'approvals', v_count,
                            'required', v_row.required_approvals);
END;
$$;

REVOKE ALL ON FUNCTION public.decide_error_correction_approval(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_error_correction_approval(uuid, text, text) TO authenticated;

-- ── Acknowledge a high-risk alert ───────────────────────────
CREATE OR REPLACE FUNCTION public.acknowledge_error_correction_alert(p_alert_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_error_correction_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Only finance and executive roles can acknowledge alerts';
  END IF;
  UPDATE public.error_correction_alerts
  SET acknowledged_by = auth.uid(), acknowledged_at = now()
  WHERE id = p_alert_id AND acknowledged_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_error_correction_alert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_error_correction_alert(uuid) TO authenticated;

-- ── Reporting ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_error_correction_report(
  p_from timestamptz DEFAULT (now() - interval '30 days'),
  p_to timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_error_correction_reviewer(auth.uid())
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'Not authorised to read the error correction report';
  END IF;

  WITH scoped AS (
    SELECT * FROM public.error_correction_audit
    WHERE created_at >= p_from AND created_at <= p_to AND status = 'posted'
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'totals', (
      SELECT jsonb_build_object(
        'corrections', count(*),
        'total_amount', coalesce(sum(amount), 0),
        'commission_amount', coalesce(sum(commission_component), 0),
        'withdrawable_amount', coalesce(sum(CASE WHEN bucket = 'withdrawable' THEN amount ELSE 0 END), 0),
        'float_amount', coalesce(sum(CASE WHEN bucket = 'float' THEN amount ELSE 0 END), 0),
        'platform_recoveries', coalesce(sum(amount), 0),
        'distinct_operators', count(DISTINCT operator_id),
        'distinct_users', count(DISTINCT target_user_id)
      ) FROM scoped
    ),
    'by_operator', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'total_amount')::numeric DESC) FROM (
        SELECT jsonb_build_object(
          'operator_id', operator_id, 'operator_name', max(operator_name),
          'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY operator_id
      ) s
    ), '[]'::jsonb),
    'by_reason', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'total_amount')::numeric DESC) FROM (
        SELECT jsonb_build_object(
          'reason_code', reason_code, 'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY reason_code
      ) s
    ), '[]'::jsonb),
    'by_bucket', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object(
          'bucket', bucket, 'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY bucket
      ) s
    ), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(x ORDER BY x->>'period' DESC) FROM (
        SELECT jsonb_build_object(
          'period', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'),
          'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY date_trunc('day', created_at)
      ) s
    ), '[]'::jsonb),
    'weekly', coalesce((
      SELECT jsonb_agg(x ORDER BY x->>'period' DESC) FROM (
        SELECT jsonb_build_object(
          'period', to_char(date_trunc('week', created_at), 'YYYY-MM-DD'),
          'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY date_trunc('week', created_at)
      ) s
    ), '[]'::jsonb),
    'monthly', coalesce((
      SELECT jsonb_agg(x ORDER BY x->>'period' DESC) FROM (
        SELECT jsonb_build_object(
          'period', to_char(date_trunc('month', created_at), 'YYYY-MM'),
          'corrections', count(*), 'total_amount', sum(amount)
        ) AS x
        FROM scoped GROUP BY date_trunc('month', created_at)
      ) s
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_error_correction_report(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_error_correction_report(timestamptz, timestamptz) TO authenticated;