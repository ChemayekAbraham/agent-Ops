CREATE OR REPLACE FUNCTION public._wh_declined_block_reason(p_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.welile_homes_subscriptions;
BEGIN
  SELECT * INTO s FROM public.welile_homes_subscriptions WHERE id = p_id;
  IF NOT FOUND THEN RETURN 'Not found (already deleted)'; END IF;
  IF s.subscription_status <> 'cancelled' THEN RETURN 'Not declined'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_historical_disbursements h WHERE h.subscription_id = p_id) THEN
    RETURN 'Linked to a recorded disbursement'; END IF;
  IF EXISTS (SELECT 1 FROM public.welile_homes_monthly_dues d WHERE d.subscription_id = p_id
             AND (coalesce(d.amount_collected,0) > 0 OR coalesce(d.commission_paid,0) > 0
                  OR d.ledger_transaction_id IS NOT NULL OR d.collection_status <> 'pending'
                  OR coalesce(d.payout_status,'unpaid') <> 'unpaid')) THEN
    RETURN 'Rent has been received on it'; END IF;
  IF EXISTS (SELECT 1 FROM public.welile_homes_float_request_items i
             JOIN public.float_requests f ON f.id = i.float_request_id
             WHERE i.subscription_id = p_id
               AND (i.released_at IS NOT NULL OR f.status <> 'rejected' OR f.disbursed_ledger_txn IS NOT NULL)) THEN
    RETURN 'Its float request is still approved or was paid'; END IF;
  IF EXISTS (SELECT 1 FROM public.welile_homes_collection_requests c WHERE c.subscription_id = p_id) THEN
    RETURN 'A wallet collection was attempted on it'; END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE (g.source_id = p_id OR g.reference_id = p_id::text)
             AND g.category NOT IN ('landlord_receivable_created','landlord_receivable_obligation')) THEN
    RETURN 'It has money entries in the ledger'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._wh_declined_block_reason(uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wh_declined_delete_check(p_subscription_ids uuid[])
RETURNS TABLE(subscription_id uuid, reason text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), array['agent_ops','coo','cfo','super_admin']) THEN
    RAISE EXCEPTION 'Not allowed' USING errcode = '42501';
  END IF;
  RETURN QUERY SELECT x, public._wh_declined_block_reason(x) FROM unnest(p_subscription_ids) x;
END $$;
REVOKE ALL ON FUNCTION public.wh_declined_delete_check(uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.wh_declined_delete_check(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_delete_declined_applications(p_subscription_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  s public.welile_homes_subscriptions;
  v_reason text;
  v_deleted jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_photos text[] := '{}';
  v_fr uuid;
  v_frs uuid[];
  v_items jsonb;
  v_photo text;
  v_ids_deleted int;
  v_fr_deleted uuid[];
  v_port_deleted int;
  v_port_updated int;
  v_dues int;
  v_net numeric;
BEGIN
  IF v_uid IS NULL OR NOT public._has_enabled_role(v_uid, array['agent_ops','super_admin']) THEN
    RAISE EXCEPTION 'Only Agent Ops can delete declined applications' USING errcode = '42501';
  END IF;
  IF NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Two-step sign-in is required' USING errcode = '42501';
  END IF;
  IF p_subscription_ids IS NULL OR array_length(p_subscription_ids,1) IS NULL THEN
    RETURN jsonb_build_object('deleted','[]'::jsonb,'skipped','[]'::jsonb,'photo_paths','[]'::jsonb);
  END IF;

  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_subscription_ids) x) LOOP
    SELECT * INTO s FROM public.welile_homes_subscriptions WHERE id = v_id FOR UPDATE;
    v_reason := public._wh_declined_block_reason(v_id);
    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', v_reason, 'landlord_name', s.landlord_name);
      CONTINUE;
    END IF;

    -- Cancel the automatic enrolment "landlord owes" amount with an opposite entry (original kept)
    SELECT coalesce(sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0) INTO v_net
      FROM public.general_ledger
     WHERE source_id = v_id AND category = 'landlord_receivable_created';
    IF v_net > 0 THEN
      PERFORM public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('amount', v_net, 'direction','cash_out',
          'category','landlord_receivable_created','ledger_scope','bridge','classification','production',
          'description','Landlord receivable cancelled: declined application deleted ('||coalesce(s.landlord_name,'landlord')||')',
          'source_table','welile_homes_subscriptions','source_id', v_id),
        jsonb_build_object('amount', v_net, 'direction','cash_in',
          'category','landlord_receivable_obligation','ledger_scope','platform','classification','production',
          'description','Landlord payout obligation cancelled: declined application deleted ('||coalesce(s.landlord_name,'landlord')||')',
          'source_table','welile_homes_subscriptions','source_id', v_id)),
        'landlord_recv_cancel:' || v_id::text, false);
    END IF;

    SELECT coalesce(array_agg(DISTINCT float_request_id), '{}') INTO v_frs
      FROM public.welile_homes_float_request_items WHERE subscription_id = v_id;
    DELETE FROM public.welile_homes_float_request_items WHERE subscription_id = v_id;
    v_fr_deleted := '{}';
    FOREACH v_fr IN ARRAY v_frs LOOP
      IF NOT EXISTS (SELECT 1 FROM public.welile_homes_float_request_items WHERE float_request_id = v_fr)
         AND EXISTS (SELECT 1 FROM public.float_requests WHERE id = v_fr AND status = 'rejected' AND disbursed_ledger_txn IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_id = v_fr OR g.reference_id = v_fr::text) THEN
        BEGIN
          DELETE FROM public.wh_float_request_events WHERE float_request_id = v_fr;
          DELETE FROM public.float_requests WHERE id = v_fr;
          v_fr_deleted := v_fr_deleted || v_fr;
        EXCEPTION WHEN others THEN NULL;
        END;
      END IF;
    END LOOP;

    WITH d AS (DELETE FROM public.wh_landlord_portfolio_verifications WHERE subscription_ids = ARRAY[v_id] RETURNING 1)
    SELECT count(*) INTO v_port_deleted FROM d;
    WITH u AS (UPDATE public.wh_landlord_portfolio_verifications SET subscription_ids = array_remove(subscription_ids, v_id)
               WHERE v_id = ANY(subscription_ids) RETURNING 1)
    SELECT count(*) INTO v_port_updated FROM u;

    v_ids_deleted := 0;
    IF NOT EXISTS (SELECT 1 FROM public.welile_homes_subscriptions o WHERE o.tenant_id = s.tenant_id AND o.id <> v_id) THEN
      SELECT photo_path INTO v_photo FROM public.wh_tenant_identity WHERE tenant_id = s.tenant_id;
      IF v_photo IS NOT NULL THEN v_photos := v_photos || v_photo; END IF;
      WITH d AS (DELETE FROM public.wh_tenant_identity WHERE tenant_id = s.tenant_id RETURNING 1)
      SELECT count(*) INTO v_ids_deleted FROM d;
    END IF;

    SELECT count(*) INTO v_dues FROM public.welile_homes_monthly_dues WHERE subscription_id = v_id;
    DELETE FROM public.welile_homes_subscriptions WHERE id = v_id;

    v_items := jsonb_build_object('float_requests_deleted', to_jsonb(v_fr_deleted),
      'unpaid_dues_deleted', v_dues, 'portfolio_records_deleted', v_port_deleted,
      'portfolio_records_updated', v_port_updated, 'tenant_id_records_deleted', v_ids_deleted,
      'landlord_receivable_cancelled', v_net);

    INSERT INTO public.wh_declined_deletion_log(subscription_id, tenant_id, agent_id, landlord_name, monthly_rent, deleted_items, deleted_by)
    VALUES (v_id, s.tenant_id, s.agent_id, s.landlord_name, s.monthly_rent, v_items, v_uid);

    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_uid, 'wh_declined_application_deleted', 'welile_homes_subscriptions', v_id::text,
      'Declined Welile Homes application permanently deleted by Agent Ops', jsonb_build_object('items', v_items));

    v_deleted := v_deleted || jsonb_build_object('id', v_id, 'landlord_name', s.landlord_name);
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped, 'photo_paths', to_jsonb(v_photos));
END $$;