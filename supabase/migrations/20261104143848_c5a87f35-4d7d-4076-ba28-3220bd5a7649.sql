CREATE TABLE public.wh_declined_deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  tenant_id uuid,
  agent_id uuid,
  landlord_name text,
  monthly_rent numeric,
  deleted_items jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_by uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wh_declined_deletion_log TO authenticated;
GRANT ALL ON public.wh_declined_deletion_log TO service_role;
ALTER TABLE public.wh_declined_deletion_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY wh_decl_del_log_read ON public.wh_declined_deletion_log FOR SELECT TO authenticated
  USING ((select public._has_enabled_role((select auth.uid()), array['agent_ops','coo','cfo','super_admin'])));
CREATE POLICY mfa_required_for_staff ON public.wh_declined_deletion_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

CREATE POLICY "wh tenant id photo delete by agent ops" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'wh-tenant-id-photos' AND (select public._has_enabled_role((select auth.uid()), array['agent_ops','super_admin'])));

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
    v_reason := NULL;
    IF NOT FOUND THEN
      v_reason := 'Not found (already deleted)';
    ELSIF s.subscription_status <> 'cancelled' THEN
      v_reason := 'Not declined';
    ELSIF EXISTS (SELECT 1 FROM public.wh_historical_disbursements h WHERE h.subscription_id = v_id) THEN
      v_reason := 'Linked to a recorded disbursement';
    ELSIF EXISTS (SELECT 1 FROM public.welile_homes_monthly_dues d WHERE d.subscription_id = v_id
                  AND (coalesce(d.amount_collected,0) > 0 OR coalesce(d.commission_paid,0) > 0
                       OR d.ledger_transaction_id IS NOT NULL OR d.collection_status <> 'pending'
                       OR coalesce(d.payout_status,'unpaid') <> 'unpaid')) THEN
      v_reason := 'Rent has been received on it';
    ELSIF EXISTS (SELECT 1 FROM public.welile_homes_float_request_items i
                  JOIN public.float_requests f ON f.id = i.float_request_id
                  WHERE i.subscription_id = v_id
                    AND (i.released_at IS NOT NULL OR f.status <> 'rejected' OR f.disbursed_ledger_txn IS NOT NULL)) THEN
      v_reason := 'Its float request is not declined or was disbursed';
    ELSIF EXISTS (SELECT 1 FROM public.welile_homes_collection_requests c WHERE c.subscription_id = v_id) THEN
      v_reason := 'A wallet collection was attempted on it';
    ELSIF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_id = v_id OR g.reference_id = v_id::text) THEN
      v_reason := 'It has ledger entries';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', v_reason,
        'landlord_name', s.landlord_name);
      CONTINUE;
    END IF;

    -- Float request lines (declined float requests only, checked above)
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
        EXCEPTION WHEN others THEN NULL; -- keep the request if anything else protects it
        END;
      END IF;
    END LOOP;

    -- Landlord portfolio verifications created only for this application
    WITH d AS (DELETE FROM public.wh_landlord_portfolio_verifications
               WHERE subscription_ids = ARRAY[v_id] RETURNING 1)
    SELECT count(*) INTO v_port_deleted FROM d;
    WITH u AS (UPDATE public.wh_landlord_portfolio_verifications
               SET subscription_ids = array_remove(subscription_ids, v_id)
               WHERE v_id = ANY(subscription_ids) RETURNING 1)
    SELECT count(*) INTO v_port_updated FROM u;

    -- Tenant ID record, only when no other enrolment uses this tenant
    v_ids_deleted := 0;
    IF NOT EXISTS (SELECT 1 FROM public.welile_homes_subscriptions o WHERE o.tenant_id = s.tenant_id AND o.id <> v_id) THEN
      SELECT photo_path INTO v_photo FROM public.wh_tenant_identity WHERE tenant_id = s.tenant_id;
      IF v_photo IS NOT NULL THEN v_photos := v_photos || v_photo; END IF;
      WITH d AS (DELETE FROM public.wh_tenant_identity WHERE tenant_id = s.tenant_id RETURNING 1)
      SELECT count(*) INTO v_ids_deleted FROM d;
    END IF;

    SELECT count(*) INTO v_dues FROM public.welile_homes_monthly_dues WHERE subscription_id = v_id;
    DELETE FROM public.welile_homes_subscriptions WHERE id = v_id; -- dues and edit history cascade

    v_items := jsonb_build_object('float_requests_deleted', to_jsonb(v_fr_deleted),
      'unpaid_dues_deleted', v_dues, 'portfolio_records_deleted', v_port_deleted,
      'portfolio_records_updated', v_port_updated, 'tenant_id_records_deleted', v_ids_deleted);

    INSERT INTO public.wh_declined_deletion_log(subscription_id, tenant_id, agent_id, landlord_name, monthly_rent, deleted_items, deleted_by)
    VALUES (v_id, s.tenant_id, s.agent_id, s.landlord_name, s.monthly_rent, v_items, v_uid);

    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
    VALUES (v_uid, 'wh_declined_application_deleted', 'welile_homes_subscriptions', v_id::text,
      jsonb_build_object('reason', 'Declined Welile Homes application permanently deleted by Agent Ops', 'items', v_items));

    v_deleted := v_deleted || jsonb_build_object('id', v_id, 'landlord_name', s.landlord_name);
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped, 'photo_paths', to_jsonb(v_photos));
END $$;
REVOKE ALL ON FUNCTION public.wh_delete_declined_applications(uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.wh_delete_declined_applications(uuid[]) TO authenticated;