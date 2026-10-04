-- 1. Incident register
CREATE TABLE public.ledger_anomaly_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_ref text NOT NULL UNIQUE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'under_investigation',
  summary text,
  gross_amount numeric,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid,
  closed_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ledger_anomaly_incidents TO authenticated;
GRANT ALL ON public.ledger_anomaly_incidents TO service_role;
ALTER TABLE public.ledger_anomaly_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance and exec can view ledger incidents"
ON public.ledger_anomaly_incidents FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- 2. Isolation register (freeze anomalous legs out of operational reporting)
CREATE TABLE public.ledger_anomaly_isolations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES public.general_ledger(id),
  incident_ref text NOT NULL REFERENCES public.ledger_anomaly_incidents(incident_ref),
  reason text NOT NULL,
  isolated_by uuid,
  isolated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ledger_anomaly_isolations TO authenticated;
GRANT ALL ON public.ledger_anomaly_isolations TO service_role;
ALTER TABLE public.ledger_anomaly_isolations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance and exec can view ledger isolations"
ON public.ledger_anomaly_isolations FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- 3. Administrative scope reclassification register (append-only, ledger rows stay immutable)
CREATE TABLE public.ledger_scope_reclassifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES public.general_ledger(id),
  original_scope text NOT NULL,
  effective_scope text NOT NULL,
  incident_ref text REFERENCES public.ledger_anomaly_incidents(incident_ref),
  reason text NOT NULL,
  approved_by text NOT NULL,
  approved_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_scope_reclass_reason_len CHECK (length(reason) >= 10),
  CONSTRAINT ledger_scope_reclass_scope_chk CHECK (effective_scope IN ('platform','wallet','bridge'))
);
GRANT SELECT ON public.ledger_scope_reclassifications TO authenticated;
GRANT ALL ON public.ledger_scope_reclassifications TO service_role;
ALTER TABLE public.ledger_scope_reclassifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance and exec can view scope reclassifications"
ON public.ledger_scope_reclassifications FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE TRIGGER trg_touch_ledger_anomaly_incidents BEFORE UPDATE ON public.ledger_anomaly_incidents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_touch_ledger_anomaly_isolations BEFORE UPDATE ON public.ledger_anomaly_isolations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_touch_ledger_scope_reclass BEFORE UPDATE ON public.ledger_scope_reclassifications
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Open the incident for the unbalanced 544,205,788 leg
INSERT INTO public.ledger_anomaly_incidents (incident_ref, title, status, summary, gross_amount)
VALUES (
  'FIN-2026-08-001',
  'Historical Migration Anomaly — Under Investigation',
  'under_investigation',
  'Single unbalanced wallet-scope journal entry 5c3a9455-ee66-488a-a3ef-91a0a7d22686 (UGX 544,205,788, cash_in, system_balance_correction, 2026-05-07 05:53:45 UTC) posted by raw migration SQL as "negative balance wipe (pass 3, incl NULL bucket)". No counterparty leg, no user_id, no wallet_bucket, no system_events and no audit_logs entry; source_table = manual_admin_action. CFO decision 2026-08-01: do NOT write off, do NOT reverse, do NOT delete. Isolate from operational reporting and require forensic reconstruction of the originating migration (2026-05-07 batch, 109 legs across 3 passes) before any accounting action.',
  544205788.00
);

-- 5. Isolate that leg
INSERT INTO public.ledger_anomaly_isolations (ledger_entry_id, incident_ref, reason)
VALUES (
  '5c3a9455-ee66-488a-a3ef-91a0a7d22686',
  'FIN-2026-08-001',
  'Unbalanced orphan journal entry of unknown origin. Frozen out of operational reporting pending forensic reconstruction. Ledger row deliberately left unchanged for audit defensibility.'
);

-- 6. Administrative reclassification of the 8 misclassified company legs (no financial adjustment)
INSERT INTO public.ledger_scope_reclassifications
  (ledger_entry_id, original_scope, effective_scope, incident_ref, reason, approved_by)
SELECT gl.id, gl.ledger_scope, 'platform', NULL,
       'Company/platform side of a balanced two-leg manual clawback or TID float recovery, mis-tagged ledger_scope=wallet at posting time. Classification correction only; amount, date, direction, category and counterparty unchanged. CFO approved 2026-08-01.',
       'CFO approval 2026-08-01'
FROM public.general_ledger gl
WHERE gl.ledger_scope = 'wallet'
  AND gl.user_id IS NULL
  AND gl.wallet_bucket IS NULL
  AND gl.id <> '5c3a9455-ee66-488a-a3ef-91a0a7d22686';

-- 7. Reporting views: effective scope + isolation flag
CREATE OR REPLACE VIEW public.v_general_ledger_effective AS
SELECT gl.*,
       COALESCE(r.effective_scope, gl.ledger_scope) AS effective_ledger_scope,
       (r.id IS NOT NULL) AS scope_reclassified,
       (i.id IS NOT NULL AND i.released_at IS NULL) AS is_isolated,
       i.incident_ref AS isolation_incident_ref
FROM public.general_ledger gl
LEFT JOIN public.ledger_scope_reclassifications r ON r.ledger_entry_id = gl.id
LEFT JOIN public.ledger_anomaly_isolations i ON i.ledger_entry_id = gl.id;

CREATE OR REPLACE VIEW public.v_general_ledger_operational AS
SELECT * FROM public.v_general_ledger_effective WHERE is_isolated = false;

GRANT SELECT ON public.v_general_ledger_effective TO authenticated, service_role;
GRANT SELECT ON public.v_general_ledger_operational TO authenticated, service_role;

-- 8. Monitoring view for wallet legs missing a bucket (report-only; blocking would halt production)
CREATE OR REPLACE VIEW public.v_wallet_legs_missing_bucket AS
SELECT date_trunc('day', created_at) AS day,
       count(*) AS legs,
       sum(amount) AS gross_amount,
       count(*) FILTER (WHERE user_id IS NULL) AS legs_without_user
FROM public.general_ledger
WHERE ledger_scope = 'wallet' AND wallet_bucket IS NULL
GROUP BY 1
ORDER BY 1 DESC;
GRANT SELECT ON public.v_wallet_legs_missing_bucket TO authenticated, service_role;

-- 9. Guardrail: no wallet-scope leg without an owner, unless a named migration window is open
CREATE OR REPLACE FUNCTION public.enforce_wallet_scope_requires_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bypass text := current_setting('ledger.migration_bypass', true);
  v_mig    text := current_setting('ledger.migration_id', true);
  v_op     text := current_setting('ledger.migration_operator', true);
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.user_id IS NULL THEN
    IF v_bypass = 'true'
       AND coalesce(length(trim(v_mig)), 0) > 0
       AND coalesce(length(trim(v_op)), 0) > 0 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Wallet-scope ledger entries require user_id. Post the company side with ledger_scope=''platform'', or open a named migration window via begin_ledger_migration().';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_enforce_wallet_scope_requires_user
BEFORE INSERT ON public.general_ledger
FOR EACH ROW EXECUTE FUNCTION public.enforce_wallet_scope_requires_user();

-- 10. Named migration window: identifier + operator + reason + audit + system event
CREATE OR REPLACE FUNCTION public.begin_ledger_migration(
  p_migration_id text,
  p_operator text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'manager'::app_role)
       OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO, Manager or Super Admin may open a ledger migration window';
  END IF;
  IF coalesce(length(trim(p_migration_id)), 0) = 0 THEN
    RAISE EXCEPTION 'Migration identifier is required';
  END IF;
  IF coalesce(length(trim(p_operator)), 0) = 0 THEN
    RAISE EXCEPTION 'Operator is required';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  PERFORM set_config('ledger.migration_bypass', 'true', true);
  PERFORM set_config('ledger.migration_id', p_migration_id, true);
  PERFORM set_config('ledger.migration_operator', p_operator, true);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
  VALUES ('ledger_migration_window_open', 'general_ledger', gen_random_uuid(), 'open',
          jsonb_build_object('migration_id', p_migration_id, 'operator', p_operator,
                             'reason', p_reason, 'opened_by', auth.uid()), now());

  INSERT INTO public.system_events (event_type, description, metadata, created_at)
  VALUES ('ledger_classification_backfilled', 'Ledger migration window opened: ' || p_migration_id,
          jsonb_build_object('migration_id', p_migration_id, 'operator', p_operator,
                             'reason', p_reason, 'opened_by', auth.uid()), now());
END;
$$;
REVOKE ALL ON FUNCTION public.begin_ledger_migration(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_ledger_migration(text, text, text) TO authenticated, service_role;