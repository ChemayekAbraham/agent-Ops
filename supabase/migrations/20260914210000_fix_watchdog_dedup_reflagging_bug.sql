-- Fixes a re-flagging bug in the missing-IP watchdog (20260914170000),
-- found by an independent E2E test agent running against production:
-- resolving a batch of alerts with an explanation made the underlying
-- rows immediately eligible to be re-inserted on the very next hourly
-- cron run, because every dedup guard was written as:
--
--   NOT EXISTS (SELECT 1 FROM security_ip_audit_alerts a
--               WHERE ... AND NOT a.resolved)
--
-- i.e. "have I already alerted on this row AND is that alert still open"
-- -- which means resolving an alert makes the guard blind to it again.
-- Confirmed empirically: after resolving the original 153 withdrawal +
-- 6 ledger-correction alerts, the very next cron tick re-inserted all
-- 159 of them as fresh unresolved rows with the exact same record_ids.
--
-- Fixed by dropping "AND NOT a.resolved" everywhere -- the dedup guard
-- now checks "has this exact (issue_type, source_table, record_id) ever
-- been alerted on before, resolved or not", which is the correct
-- semantic for a watchdog: once triaged, a row does not resurface on its
-- own. A resolved alert can still be manually reopened (set resolved =
-- false) if new information calls for it.
--
-- The 159 freshly re-flagged duplicate rows this bug produced were
-- resolved separately with a note pointing back at this migration and at
-- their original resolution_note, rather than deleted (this table is an
-- audit trail of what the watchdog found and when; deleting a row would
-- itself undermine that).

CREATE OR REPLACE FUNCTION public.detect_missing_ip_on_sensitive_actions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_window timestamptz := now() - interval '48 hours';
BEGIN
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
        AND a.source_table = 'system_events' AND a.record_id = se.related_entity_id::text
    );

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
        AND a.source_table = 'general_ledger' AND a.record_id = gl.id::text
    );

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
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text
    );

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
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text
    );

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
        AND a.source_table = 'audit_logs' AND a.record_id = al.id::text
    );

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
      AND a.source_table = t.tbl AND a.record_id = t.id::text
  );

  INSERT INTO public.security_ip_audit_alerts (issue_type, severity, source_table, record_id, action_or_event, occurred_at, details)
  SELECT 'kyc_change_missing_ip', 'high', 'kyc_level_change_audit', k.id::text, k.action, k.created_at,
         jsonb_build_object('user_id', k.user_id, 'actor_id', k.actor_id, 'old_level', k.old_level, 'new_level', k.new_level)
  FROM public.kyc_level_change_audit k
  WHERE k.ip_address IS NULL
    AND k.created_at > v_window
    AND NOT EXISTS (
      SELECT 1 FROM public.security_ip_audit_alerts a
      WHERE a.issue_type = 'kyc_change_missing_ip'
        AND a.source_table = 'kyc_level_change_audit' AND a.record_id = k.id::text
    );

  RETURN jsonb_build_object('ok', true, 'ran_at', now());
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'ran_at', now());
END;
$function$;
