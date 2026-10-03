CREATE OR REPLACE FUNCTION public.cfo_s12_case_evidence(p_collection_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE s public.fin_collection_reconciliation_s11%ROWTYPE; c public.agent_collections%ROWTYPE; v_plan_agent uuid; v_phone text; r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO s FROM public.fin_collection_reconciliation_s11 WHERE collection_id = p_collection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 11 population'; END IF;
  SELECT * INTO c FROM public.agent_collections WHERE id = p_collection_id;
  SELECT agent_id INTO v_plan_agent FROM public.rent_requests WHERE id = s.rent_plan_id;
  SELECT phone INTO v_phone FROM public.profiles WHERE id = s.tenant_id;
  SELECT jsonb_build_object(
    'recorded_agent_id', s.agent_id, 'plan_agent_id', v_plan_agent,
    'collection', jsonb_build_object('tracking_id', c.tracking_id, 'payment_method', c.payment_method, 'channel', c.collection_channel,
       'momo_provider', c.momo_provider, 'momo_phone', c.momo_phone, 'momo_payer_name', c.momo_payer_name, 'momo_transaction_id', c.momo_transaction_id,
       'notes', c.notes, 'location_name', c.location_name, 'sms_sent_agent', c.sms_sent_agent, 'sms_sent_tenant', c.sms_sent_tenant,
       'float_before', c.float_before, 'float_after', c.float_after, 'client_ref', c.client_ref, 'deposit_request_id', c.deposit_request_id,
       'initiated_by', c.initiated_by, 'initiated_by_name', (SELECT full_name FROM public.profiles WHERE id = c.initiated_by), 'created_at', c.created_at),
    'agent_receipts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ar.id, 'agent_id', ar.agent_id, 'agent_name', p.full_name, 'payer_name', ar.payer_name,
       'payer_phone', ar.payer_phone, 'amount', ar.amount, 'method', ar.payment_method, 'transaction_id', ar.transaction_id,
       'image_url', ar.receipt_image_url, 'notes', ar.notes, 'created_at', ar.created_at) ORDER BY ar.created_at)
       FROM public.agent_receipts ar LEFT JOIN public.profiles p ON p.id = ar.agent_id
       WHERE ar.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'
         AND ((ar.agent_id IN (s.agent_id, v_plan_agent) AND ar.amount = c.amount)
              OR (v_phone IS NOT NULL AND right(regexp_replace(coalesce(ar.payer_phone,''),'\D','','g'),9) = right(regexp_replace(v_phone,'\D','','g'),9)))), '[]'::jsonb),
    'tenant_receipts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ur.id, 'receipt_number_id', ur.receipt_number_id, 'description', ur.items_description,
       'amount', ur.claimed_amount, 'verified', ur.verified, 'verified_at', ur.verified_at, 'created_at', ur.created_at) ORDER BY ur.created_at)
       FROM public.user_receipts ur WHERE ur.user_id = s.tenant_id AND ur.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'), '[]'::jsonb),
    'deposits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'user_id', d.user_id, 'user_name', p.full_name, 'agent_id', d.agent_id, 'amount', d.amount,
       'status', d.status, 'provider', d.provider, 'transaction_id', d.transaction_id, 'transaction_date', d.transaction_date, 'purpose', d.deposit_purpose,
       'notes', d.notes, 'created_at', d.created_at, 'linked', d.id = c.deposit_request_id) ORDER BY d.created_at)
       FROM public.deposit_requests d LEFT JOIN public.profiles p ON p.id = d.user_id
       WHERE d.id = c.deposit_request_id
          OR ((d.user_id IN (s.agent_id, v_plan_agent) OR d.agent_id IN (s.agent_id, v_plan_agent)) AND d.amount = c.amount
              AND d.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days')), '[]'::jsonb),
    'visits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'agent_id', v.agent_id, 'agent_name', p.full_name, 'latitude', v.latitude, 'longitude', v.longitude,
       'accuracy', v.accuracy, 'location_name', v.location_name, 'checked_in_at', v.checked_in_at,
       'same_instant', abs(extract(epoch FROM v.created_at - c.created_at)) < 2) ORDER BY v.created_at)
       FROM public.agent_visits v LEFT JOIN public.profiles p ON p.id = v.agent_id
       WHERE v.tenant_id = s.tenant_id AND v.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'), '[]'::jsonb),
    'ledger', coalesce((SELECT jsonb_agg(jsonb_build_object('direction', g.direction, 'category', g.category, 'amount', g.amount, 'bucket', g.wallet_bucket,
       'user_id', g.user_id, 'user_name', p.full_name, 'description', g.description, 'created_at', g.created_at) ORDER BY g.created_at)
       FROM public.general_ledger g LEFT JOIN public.profiles p ON p.id = g.user_id WHERE g.transaction_group_id::text = s.ledger_group), '[]'::jsonb),
    'files', coalesce((SELECT jsonb_agg(jsonb_build_object('path', so.name, 'size', so.metadata->>'size', 'uploaded_at', so.created_at) ORDER BY so.created_at)
       FROM storage.objects so WHERE so.bucket_id = 'collection-evidence' AND so.name LIKE p_collection_id::text || '/%'), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $f$;
REVOKE ALL ON FUNCTION public.cfo_s12_case_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s12_case_evidence(uuid) TO authenticated;