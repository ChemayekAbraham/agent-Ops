
CREATE OR REPLACE FUNCTION public.bulk_recover_gap_alerts(p_alert_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_alert record;
  v_group uuid;
  v_recovered int := 0;
  v_duplicate int := 0;
  v_skipped int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_details jsonb := '[]'::jsonb;
  v_tid_norm text;
BEGIN
  IF NOT (
    public.has_role(v_caller, 'financial_ops'::app_role) OR
    public.has_role(v_caller, 'cfo'::app_role) OR
    public.has_role(v_caller, 'cto'::app_role) OR
    public.has_role(v_caller, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_alert_ids IS NULL OR array_length(p_alert_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('recovered',0,'duplicate',0,'skipped',0,'errors','[]'::jsonb,'details','[]'::jsonb);
  END IF;

  FOR v_alert IN
    SELECT *
    FROM public.deposit_bridge_gap_alerts
    WHERE id = ANY(p_alert_ids)
      AND resolved_at IS NULL
    ORDER BY detected_at ASC
  LOOP
    BEGIN
      -- Skip if not enough data to recover
      IF v_alert.user_id IS NULL OR v_alert.amount IS NULL OR v_alert.amount <= 0 THEN
        v_skipped := v_skipped + 1;
        v_details := v_details || jsonb_build_object(
          'alert_id', v_alert.id,
          'transaction_id', v_alert.transaction_id,
          'status', 'skipped',
          'reason', 'missing user_id or amount'
        );
        CONTINUE;
      END IF;

      -- Skip if the TID is already reconciled (duplicate guard)
      v_tid_norm := coalesce(
        public.extract_tid_normalized(v_alert.transaction_id),
        v_alert.transaction_id
      );
      IF v_tid_norm IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.ledger_reconciled_tids WHERE tid_normalized = v_tid_norm
      ) THEN
        v_duplicate := v_duplicate + 1;
        UPDATE public.deposit_bridge_gap_alerts
        SET resolved_at = now(),
            resolved_by = v_caller,
            resolution_notes = coalesce(resolution_notes,'') ||
              case when resolution_notes is null then '' else E'\n' end ||
              'Bulk recovery: TID already reconciled — closed without double credit.'
        WHERE id = v_alert.id;
        v_details := v_details || jsonb_build_object(
          'alert_id', v_alert.id,
          'transaction_id', v_alert.transaction_id,
          'status', 'duplicate_closed'
        );
        CONTINUE;
      END IF;

      -- Post balanced production float credit (mirrors the manual-recovery pattern)
      v_group := gen_random_uuid();

      INSERT INTO public.general_ledger (
        transaction_group_id, transaction_date, amount, direction, category,
        description, reference_id, idempotency_key,
        user_id, ledger_scope, wallet_bucket, recipient_type,
        account, source_table, classification, currency
      ) VALUES (
        v_group, now(), v_alert.amount, 'cash_in', 'agent_float_deposit',
        'Bulk recovery — bridge gap. TID ' || coalesce(v_alert.transaction_id,'(none)') ||
          ' UGX ' || to_char(v_alert.amount,'FM999,999,999'),
        coalesce('TID' || v_alert.transaction_id, v_alert.id::text),
        'bulk-recover-gap-' || v_alert.id::text || '-user',
        v_alert.user_id, 'wallet', 'float', 'operational_wallet',
        'wallet', 'ledger_transaction', 'production', 'UGX'
      );

      INSERT INTO public.general_ledger (
        transaction_group_id, transaction_date, amount, direction, category,
        description, reference_id, idempotency_key,
        user_id, ledger_scope,
        account, source_table, classification, currency
      ) VALUES (
        v_group, now(), v_alert.amount, 'cash_out', 'agent_float_deposit',
        'Platform offset — bulk recovery TID ' || coalesce(v_alert.transaction_id,'(none)'),
        coalesce('TID' || v_alert.transaction_id, v_alert.id::text),
        'bulk-recover-gap-' || v_alert.id::text || '-platform',
        v_alert.user_id, 'wallet',
        'platform', 'ledger_transaction', 'production', 'UGX'
      );

      UPDATE public.deposit_bridge_gap_alerts
      SET resolved_at = now(),
          resolved_by = v_caller,
          resolution_notes = coalesce(resolution_notes,'') ||
            case when resolution_notes is null then '' else E'\n' end ||
            'Bulk recovery: production float credit posted (group ' || v_group::text || ').'
      WHERE id = v_alert.id;

      v_recovered := v_recovered + 1;
      v_details := v_details || jsonb_build_object(
        'alert_id', v_alert.id,
        'transaction_id', v_alert.transaction_id,
        'amount', v_alert.amount,
        'user_id', v_alert.user_id,
        'group_id', v_group,
        'status', 'recovered'
      );

    EXCEPTION
      WHEN unique_violation THEN
        -- Trigger caught it as a duplicate mid-flight
        v_duplicate := v_duplicate + 1;
        UPDATE public.deposit_bridge_gap_alerts
        SET resolved_at = now(),
            resolved_by = v_caller,
            resolution_notes = coalesce(resolution_notes,'') ||
              case when resolution_notes is null then '' else E'\n' end ||
              'Bulk recovery: TID guard reported duplicate — closed without double credit.'
        WHERE id = v_alert.id;
        v_details := v_details || jsonb_build_object(
          'alert_id', v_alert.id,
          'transaction_id', v_alert.transaction_id,
          'status', 'duplicate_closed'
        );
      WHEN OTHERS THEN
        v_errors := v_errors || jsonb_build_object(
          'alert_id', v_alert.id,
          'transaction_id', v_alert.transaction_id,
          'error', SQLERRM
        );
        v_details := v_details || jsonb_build_object(
          'alert_id', v_alert.id,
          'transaction_id', v_alert.transaction_id,
          'status', 'error',
          'error', SQLERRM
        );
    END;
  END LOOP;

  -- Audit
  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, details)
    VALUES (
      v_caller,
      'bulk_recover_gap',
      'deposit_bridge_gap_alerts',
      gen_random_uuid(),
      'bulk-fix',
      jsonb_build_object(
        'requested', array_length(p_alert_ids,1),
        'recovered', v_recovered,
        'duplicate', v_duplicate,
        'skipped', v_skipped,
        'errors', v_errors
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'recovered', v_recovered,
    'duplicate', v_duplicate,
    'skipped', v_skipped,
    'errors', v_errors,
    'details', v_details
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_recover_gap_alerts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_recover_gap_alerts(uuid[]) TO authenticated;
