-- Item #3 of the user's four closure requirements: a missing-IP watchdog.
--
-- Every prior migration in this series added IP *capture*. None of them
-- alert when capture comes up empty for an action where it matters. This
-- adds that check, following the project's existing detect_* /
-- *_alerts convention (e.g. detect_payout_proof_integrity ->
-- payout_proof_integrity_alerts), rather than inventing a new mechanism.
--
-- Checks correspond directly to the user's own named examples:
--   - withdrawal approved/rejected without IP        -> system_events
--   - direct credit / ledger maintenance without IP  -> general_ledger
--     (category = 'system_balance_correction', the one ledger category
--     that is genuinely a manual/admin action rather than an automated
--     batch posting -- interest accrual, referral bonuses, etc. are
--     legitimately system-initiated with no browser IP and are excluded,
--     confirmed by inspecting which categories still show null IP after
--     item 2's create_ledger_transaction fix went live)
--   - role granted/disabled without IP                -> audit_logs
--   - payout destination changed without IP           -> audit_logs
--     (partner_agreements + landlord material changes; the landlord path
--     excludes rows already explained by the agent-attribution fix in
--     64bde2d6d, which logs a companion landlord_momo_number_corrected_by_agent
--     row with the real IP for that one known, now-fixed-going-forward
--     source -- so this does not re-flag what has already been resolved)
--   - agreement accepted without IP                   -> the 7 tables
--     the 20260914160000 migration just hardened (protects against
--     regression now that capture is server-side)
--   - KYC level/status changed without IP              -> kyc_level_change_audit
--
-- Each check is duplicate-guarded against unresolved alerts for the same
-- (source_table, record_id, issue_type), same pattern as
-- payout_proof_integrity_alerts, and scoped to a rolling 48-hour window so
-- a run that is briefly late doesn't miss anything and the scan stays
-- cheap against tables with hundreds of thousands of historical rows.

CREATE TABLE IF NOT EXISTS public.security_ip_audit_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_type text NOT NULL,
  severity text NOT NULL DEFAULT 'high',
  source_table text NOT NULL,
  record_id text,
  action_or_event text,
  occurred_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_ip_audit_alerts_unresolved
  ON public.security_ip_audit_alerts (issue_type, source_table, record_id)
  WHERE NOT resolved;

ALTER TABLE public.security_ip_audit_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CTO/CFO view security ip audit alerts" ON public.security_ip_audit_alerts;
CREATE POLICY "CTO/CFO view security ip audit alerts"
  ON public.security_ip_audit_alerts FOR SELECT
  USING (public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'cfo'));

CREATE OR REPLACE FUNCTION public.detect_missing_ip_on_sensitive_actions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_window timestamptz := now() - interval '48 hours';
BEGIN
  -- Withdrawal approved / rejected without IP. log_withdrawal_status_event()
  -- writes through log_system_event(), which populates user_id (the actor)
  -- and related_entity_id (the withdrawal id) -- NOT actor_id/entity_id,
  -- which this table also has but which this writer leaves null.
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'withdrawal_status_event_missing_ip', 'high', 'system_events', se.related_entity_id::text, se.event_type, se.created_at,
         jsonb_build_object('user_id', se.user_id, 'metadata', se.metadata)
  FROM public.system_events se
  WHERE se.event_type IN ('withdrawal_approved', 'withdrawal_rejected')
    AND se.ip_address IS NULL
    AND se.created_at > v_window
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'withdrawal_status_event_missing_ip'
        AND a.source_table = 'system_events' AND a.record_id = se.related_entity_id::text AND NOT a.resolved
    );

  -- Direct credit / ledger maintenance without IP. Excludes the two known
  -- fully-automated posting patterns under this category (the daily payroll
  -- loyalty bonus cron and platform auto-expense transfers, both tagged
  -- "[Automated]" or matching the payroll description) -- confirmed by
  -- inspecting actual post-fix rows: 77 of 85 initial hits were the payroll
  -- job alone. What remains ("Merchant desk float set to ...", with a typed
  -- Reason/Evidence) are manual admin corrections and are the real signal.
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'ledger_maintenance_missing_ip', 'critical', 'general_ledger', gl.id::text, gl.category, gl.created_at,
         jsonb_build_object('amount', gl.amount, 'user_id', gl.user_id, 'description', gl.description)
  FROM public.general_ledger gl
  WHERE gl.category = 'system_balance_correction'
    AND gl.ip_address IS NULL
    AND gl.created_at > v_window
    AND gl.description NOT ILIKE 'Payroll loyalty bonus%'
    AND gl.description NOT ILIKE '%[Automated]%'
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'ledger_maintenance_missing_ip'
        AND a.source_table = 'general_ledger' AND a.record_id = gl.id::text AND NOT a.resolved
    );

  -- Role granted / disabled without IP.
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'role_change_missing_ip', 'high', 'audit_logs', al.id::text, al.action_type, al.created_at,
         jsonb_build_object('user_id', al.user_id, 'record_id', al.record_id, 'metadata', al.metadata)
  FROM public.audit_logs al
  WHERE al.action_type IN ('role_assigned', 'role_disabled', 'role_removed', 'staff_role_disabled', 'staff_role_enabled', 'forced_default_role_set', 'cfo_merchant_agent_role_removed')
    AND al.ip_address IS NULL
    AND al.created_at > v_window
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'role_change_missing_ip'
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text AND NOT a.resolved
    );

  -- Payout destination changed without IP (partner bank details).
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'payout_destination_change_missing_ip', 'critical', 'audit_logs', al.id::text, al.action_type, al.created_at,
         jsonb_build_object('user_id', al.user_id, 'record_id', al.record_id, 'old_values', al.old_values, 'new_values', al.new_values)
  FROM public.audit_logs al
  WHERE al.action_type = 'partner_payout_destination_changed'
    AND al.ip_address IS NULL
    AND al.created_at > v_window
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'payout_destination_change_missing_ip'
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text AND NOT a.resolved
    );

  -- Payout destination changed without IP (landlord MoMo/bank fields) --
  -- excludes rows already explained by the companion agent-attribution
  -- audit row (landlord_momo_number_corrected_by_agent) added in 64bde2d6d.
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'landlord_payout_change_missing_ip', 'critical', 'audit_logs', al.id::text, al.action_type, al.created_at,
         jsonb_build_object('user_id', al.user_id, 'record_id', al.record_id, 'metadata', al.metadata)
  FROM public.audit_logs al
  WHERE al.action_type = 'landlord_material_change_applied'
    AND al.ip_address IS NULL
    AND al.created_at > v_window
    AND (al.metadata -> 'fields') ?| ARRAY['mobile_money_number', 'mobile_money_name', 'bank_name', 'account_number']
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_logs companion
      WHERE companion.action_type = 'landlord_momo_number_corrected_by_agent'
        AND companion.record_id = al.record_id
        AND companion.created_at BETWEEN al.created_at - interval '5 seconds' AND al.created_at + interval '5 seconds'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'landlord_payout_change_missing_ip'
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text AND NOT a.resolved
    );

  -- Agreement accepted without IP (regression guard on the 7 tables
  -- hardened in 20260914160000).
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'agreement_acceptance_missing_ip', 'high', t.tbl, t.id::text, 'agreement_acceptance', t.created_at, '{}'::jsonb
  FROM (
    SELECT 'tenant_agreement_acceptance' AS tbl, id, created_at FROM public.tenant_agreement_acceptance WHERE ip_address IS NULL AND created_at > v_window
    UNION ALL
    SELECT 'merchant_agreement_acceptance', id, created_at FROM public.merchant_agreement_acceptance WHERE ip_address IS NULL AND created_at > v_window
    UNION ALL
    SELECT 'lender_vouch_agreement_acceptance', id, accepted_at FROM public.lender_vouch_agreement_acceptance WHERE ip_address IS NULL AND accepted_at > v_window
    UNION ALL
    SELECT 'lending_agent_agreement_acceptance', id, accepted_at FROM public.lending_agent_agreement_acceptance WHERE ip_address IS NULL AND accepted_at > v_window
    UNION ALL
    SELECT 'supporter_agreement_acceptance', id, created_at FROM public.supporter_agreement_acceptance WHERE ip_address IS NULL AND created_at > v_window
    UNION ALL
    SELECT 'employee_agreement_acceptance', id, created_at FROM public.employee_agreement_acceptance WHERE ip_address IS NULL AND created_at > v_window
    UNION ALL
    SELECT 'borrower_vouch_disclosures', id, acknowledged_at FROM public.borrower_vouch_disclosures WHERE ip_address IS NULL AND acknowledged_at > v_window
  ) t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.security_ip_audit_alerts a
    WHERE a.issue_type = 'agreement_acceptance_missing_ip'
      AND a.source_table = t.tbl AND a.record_id = t.id::text AND NOT a.resolved
  );

  -- KYC level/status changed without IP.
  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'kyc_change_missing_ip', 'high', 'kyc_level_change_audit', k.id::text, k.action, k.created_at,
         jsonb_build_object('user_id', k.user_id, 'actor_id', k.actor_id, 'old_level', k.old_level, 'new_level', k.new_level)
  FROM public.kyc_level_change_audit k
  WHERE k.ip_address IS NULL
    AND k.created_at > v_window
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'kyc_change_missing_ip'
        AND a.source_table = 'kyc_level_change_audit' AND a.record_id = k.id::text AND NOT a.resolved
    );

  RETURN jsonb_build_object('ok', true, 'ran_at', now());
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'ran_at', now());
END;
$function$;

SELECT cron.schedule(
  'detect-missing-ip-on-sensitive-actions-hourly',
  '20 * * * *',
  $$SELECT public.detect_missing_ip_on_sensitive_actions();$$
);
