CREATE TABLE public.wh_historical_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('entry','reversal')),
  reverses_id uuid UNIQUE REFERENCES public.wh_historical_disbursements(id),
  agent_id uuid,
  landlord_id uuid,
  subscription_id uuid,
  amount numeric,
  channel text,
  reference text,
  paid_on date,
  notes text,
  evidence_path text,
  reason text,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='entry' AND reverses_id IS NULL AND agent_id IS NOT NULL AND subscription_id IS NOT NULL AND amount > 0
          AND channel IN ('cash','mtn_momo','airtel_money','bank_transfer','other') AND paid_on IS NOT NULL AND length(trim(reference))>0)
      OR (kind='reversal' AND reverses_id IS NOT NULL AND length(trim(coalesce(reason,'')))>=10))
);
GRANT ALL ON public.wh_historical_disbursements TO service_role;
ALTER TABLE public.wh_historical_disbursements ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_required_for_staff ON public.wh_historical_disbursements AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE INDEX ON public.wh_historical_disbursements (subscription_id);
CREATE INDEX ON public.wh_historical_disbursements (agent_id, paid_on);

CREATE OR REPLACE FUNCTION public._wh_hist_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Historical disbursement records cannot be edited or deleted; reverse them instead'; END $$;
CREATE TRIGGER trg_wh_hist_append_only BEFORE UPDATE OR DELETE ON public.wh_historical_disbursements
  FOR EACH ROW EXECUTE FUNCTION public._wh_hist_append_only();

CREATE OR REPLACE FUNCTION public._wh_hist_can_write() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._has_enabled_role(auth.uid(), ARRAY['agent_ops','super_admin']) $$;
CREATE OR REPLACE FUNCTION public._wh_hist_can_read() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._has_enabled_role(auth.uid(), ARRAY['agent_ops','coo','cfo','super_admin']) $$;
GRANT EXECUTE ON FUNCTION public._wh_hist_can_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public._wh_hist_can_read() TO authenticated;

-- Record a historical (off-system) disbursement. Data only: no ledger, wallet, float or plan change.
CREATE OR REPLACE FUNCTION public.wh_hist_record(
  p_client_ref uuid, p_agent_id uuid, p_subscription_id uuid, p_amount numeric, p_channel text,
  p_reference text, p_paid_on date, p_notes text DEFAULT NULL, p_evidence_path text DEFAULT NULL,
  p_confirm_duplicate boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing uuid; v_dup uuid; v_landlord uuid; v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public._wh_hist_can_write() THEN
    RAISE EXCEPTION 'Only Agent Ops can record past disbursements' USING errcode='42501'; END IF;
  SELECT id INTO v_existing FROM wh_historical_disbursements WHERE client_ref = p_client_ref;
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('id', v_existing, 'already_saved', true); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero' USING errcode='22023'; END IF;
  IF p_paid_on IS NULL OR p_paid_on > (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'Date paid cannot be in the future' USING errcode='22023'; END IF;
  IF p_channel NOT IN ('cash','mtn_momo','airtel_money','bank_transfer','other') THEN
    RAISE EXCEPTION 'Choose a valid channel' USING errcode='22023'; END IF;
  IF length(trim(coalesce(p_reference,''))) = 0 OR length(p_reference) > 120 THEN
    RAISE EXCEPTION 'Enter the transaction or receipt reference' USING errcode='22023'; END IF;
  IF length(coalesce(p_notes,'')) > 1000 THEN RAISE EXCEPTION 'Notes are too long' USING errcode='22023'; END IF;
  IF p_evidence_path IS NOT NULL AND p_evidence_path NOT LIKE 'entries/%' THEN
    RAISE EXCEPTION 'Invalid evidence file' USING errcode='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_agent_id) THEN RAISE EXCEPTION 'Agent not found' USING errcode='22023'; END IF;
  SELECT landlord_id INTO v_landlord FROM welile_homes_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent Plan not found' USING errcode='22023'; END IF;

  IF NOT p_confirm_duplicate THEN
    SELECT e.id INTO v_dup FROM wh_historical_disbursements e
     WHERE e.kind='entry' AND e.agent_id=p_agent_id AND e.amount=p_amount AND e.paid_on=p_paid_on
       AND lower(trim(e.reference)) = lower(trim(p_reference))
       AND NOT EXISTS (SELECT 1 FROM wh_historical_disbursements r WHERE r.reverses_id=e.id) LIMIT 1;
    IF v_dup IS NOT NULL THEN RETURN jsonb_build_object('duplicate', true, 'existing_id', v_dup); END IF;
  END IF;

  INSERT INTO wh_historical_disbursements (client_ref, kind, agent_id, landlord_id, subscription_id, amount, channel, reference, paid_on, notes, evidence_path, recorded_by)
  VALUES (p_client_ref, 'entry', p_agent_id, v_landlord, p_subscription_id, p_amount, p_channel, trim(p_reference), p_paid_on, nullif(trim(p_notes),''), p_evidence_path, auth.uid())
  ON CONFLICT (client_ref) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM wh_historical_disbursements WHERE client_ref=p_client_ref;
    RETURN jsonb_build_object('id', v_id, 'already_saved', true); END IF;
  RETURN jsonb_build_object('id', v_id, 'saved', true);
END $$;

CREATE OR REPLACE FUNCTION public.wh_hist_reverse(p_client_ref uuid, p_entry_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public._wh_hist_can_write() THEN
    RAISE EXCEPTION 'Only Agent Ops can reverse past disbursements' USING errcode='42501'; END IF;
  SELECT id INTO v_id FROM wh_historical_disbursements WHERE client_ref=p_client_ref;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('id', v_id, 'already_saved', true); END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Give a reason of at least 10 characters' USING errcode='22023'; END IF;
  PERFORM 1 FROM wh_historical_disbursements WHERE id=p_entry_id AND kind='entry' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found' USING errcode='22023'; END IF;
  IF EXISTS (SELECT 1 FROM wh_historical_disbursements WHERE reverses_id=p_entry_id) THEN
    RAISE EXCEPTION 'This entry is already reversed' USING errcode='22023'; END IF;
  INSERT INTO wh_historical_disbursements (client_ref, kind, reverses_id, reason, recorded_by)
  VALUES (p_client_ref, 'reversal', p_entry_id, trim(p_reason), auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'saved', true);
END $$;

-- Pickers for the form (Agent Ops only).
CREATE OR REPLACE FUNCTION public.wh_hist_search_plans(p_search text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._wh_hist_can_write() THEN RAISE EXCEPTION 'not allowed' USING errcode='42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(x) FROM (
    SELECT s.id AS subscription_id, coalesce(tp.full_name, 'Tenant') AS tenant_name, tp.phone AS tenant_phone,
           s.landlord_id, coalesce(l.name, s.landlord_name, 'Landlord') AS landlord_name,
           s.agent_id, ap.full_name AS agent_name, s.monthly_rent, s.subscription_status
      FROM welile_homes_subscriptions s
      LEFT JOIN profiles tp ON tp.id = s.tenant_id
      LEFT JOIN profiles ap ON ap.id = s.agent_id
      LEFT JOIN landlords l ON l.id = s.landlord_id
     WHERE coalesce(trim(p_search),'') = '' OR tp.full_name ILIKE '%'||trim(p_search)||'%' OR tp.phone ILIKE '%'||trim(p_search)||'%'
        OR coalesce(l.name, s.landlord_name) ILIKE '%'||trim(p_search)||'%' OR ap.full_name ILIKE '%'||trim(p_search)||'%'
     ORDER BY s.created_at DESC LIMIT 25) x), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.wh_hist_search_agents(p_search text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._wh_hist_can_write() THEN RAISE EXCEPTION 'not allowed' USING errcode='42501'; END IF;
  IF length(trim(coalesce(p_search,''))) < 2 THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(x) FROM (
    SELECT DISTINCT p.id, p.full_name, p.phone FROM profiles p JOIN user_roles ur ON ur.user_id=p.id AND ur.enabled AND ur.role::text IN ('agent','senior_agent','sub_agent')
     WHERE p.full_name ILIKE '%'||trim(p_search)||'%' OR p.phone ILIKE '%'||trim(p_search)||'%' LIMIT 20) x), '[]'::jsonb);
END $$;

-- One read for every view: system-recorded and manually-entered rows, kept separate, with totals.
CREATE OR REPLACE FUNCTION public.wh_hist_overview(p_agent_id uuid DEFAULT NULL, p_channel text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_subscription_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_manual jsonb; v_system jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._wh_hist_can_read() THEN RAISE EXCEPTION 'not allowed' USING errcode='42501'; END IF;
  SELECT coalesce(jsonb_agg(m ORDER BY m.paid_on DESC, m.recorded_at DESC), '[]'::jsonb) INTO v_manual FROM (
    SELECT e.id, 'manual' AS source, e.agent_id, ap.full_name AS agent_name, e.landlord_id,
           coalesce(l.name, s.landlord_name) AS landlord_name, e.subscription_id, tp.full_name AS tenant_name,
           e.amount, e.channel, e.reference, e.paid_on, e.notes, e.evidence_path,
           e.recorded_by, rp.full_name AS recorded_by_name, e.recorded_at,
           r.id IS NOT NULL AS reversed, r.reason AS reversal_reason, r.recorded_at AS reversed_at, rr.full_name AS reversed_by_name
      FROM wh_historical_disbursements e
      LEFT JOIN wh_historical_disbursements r ON r.reverses_id = e.id
      LEFT JOIN profiles ap ON ap.id=e.agent_id LEFT JOIN profiles rp ON rp.id=e.recorded_by LEFT JOIN profiles rr ON rr.id=r.recorded_by
      LEFT JOIN welile_homes_subscriptions s ON s.id=e.subscription_id LEFT JOIN profiles tp ON tp.id=s.tenant_id
      LEFT JOIN landlords l ON l.id=e.landlord_id
     WHERE e.kind='entry' AND (p_agent_id IS NULL OR e.agent_id=p_agent_id) AND (p_channel IS NULL OR e.channel=p_channel)
       AND (p_from IS NULL OR e.paid_on>=p_from) AND (p_to IS NULL OR e.paid_on<=p_to)
       AND (p_subscription_id IS NULL OR e.subscription_id=p_subscription_id)) m;

  SELECT coalesce(jsonb_agg(x ORDER BY x.paid_on DESC), '[]'::jsonb) INTO v_system FROM (
    SELECT f.id, 'system' AS source, f.agent_id, ap.full_name AS agent_name,
           coalesce(f.approved_amount, f.requested_amount) AS amount, 'in_app' AS channel,
           coalesce(f.settlement_reference, f.float_delivery_tid) AS reference,
           (coalesce(f.settled_at, f.updated_at) AT TIME ZONE 'Africa/Kampala')::date AS paid_on, f.reason AS notes,
           (SELECT jsonb_agg(i.subscription_id) FROM welile_homes_float_request_items i WHERE i.float_request_id=f.id) AS subscription_ids
      FROM float_requests f LEFT JOIN profiles ap ON ap.id=f.agent_id
     WHERE f.product='welile_homes' AND f.disbursed_ledger_txn IS NOT NULL
       AND (p_agent_id IS NULL OR f.agent_id=p_agent_id) AND (p_channel IS NULL OR p_channel='in_app')
       AND (p_from IS NULL OR (coalesce(f.settled_at, f.updated_at) AT TIME ZONE 'Africa/Kampala')::date>=p_from)
       AND (p_to IS NULL OR (coalesce(f.settled_at, f.updated_at) AT TIME ZONE 'Africa/Kampala')::date<=p_to)
       AND (p_subscription_id IS NULL OR EXISTS (SELECT 1 FROM welile_homes_float_request_items i WHERE i.float_request_id=f.id AND i.subscription_id=p_subscription_id))) x;
  IF p_channel IS NOT NULL AND p_channel <> 'in_app' THEN v_system := '[]'::jsonb; END IF;

  RETURN jsonb_build_object(
    'manual', v_manual, 'system', v_system,
    'manual_total', (SELECT coalesce(sum((r->>'amount')::numeric),0) FROM jsonb_array_elements(v_manual) r WHERE NOT (r->>'reversed')::boolean),
    'system_total', (SELECT coalesce(sum((r->>'amount')::numeric),0) FROM jsonb_array_elements(v_system) r),
    'manual_count', (SELECT count(*) FROM jsonb_array_elements(v_manual) r WHERE NOT (r->>'reversed')::boolean),
    'system_count', jsonb_array_length(v_system),
    'can_write', public._wh_hist_can_write());
END $$;

REVOKE ALL ON FUNCTION public.wh_hist_record(uuid,uuid,uuid,numeric,text,text,date,text,text,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wh_hist_reverse(uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wh_hist_search_plans(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wh_hist_search_agents(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wh_hist_overview(uuid,text,date,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_hist_record(uuid,uuid,uuid,numeric,text,text,date,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wh_hist_reverse(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wh_hist_search_plans(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wh_hist_search_agents(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wh_hist_overview(uuid,text,date,date,uuid) TO authenticated;

CREATE POLICY "wh hist evidence upload by agent ops" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='wh-historical-evidence' AND (storage.foldername(name))[1]='entries' AND (select public._wh_hist_can_write()));
CREATE POLICY "wh hist evidence read by ops coo cfo" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='wh-historical-evidence' AND (select public._wh_hist_can_read()));