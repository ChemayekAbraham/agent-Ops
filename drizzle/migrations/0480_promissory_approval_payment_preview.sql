CREATE OR REPLACE FUNCTION public.preview_promissory_note_approvals(p_note_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_rate numeric; v_rows jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id=v_actor AND COALESCE(enabled,true)
    AND role = ANY(ARRAY['operations','cfo','coo','super_admin','manager','partner_ops','ceo']::public.app_role[])
  ) THEN RAISE EXCEPTION 'Not authorised to preview promissory approvals'; END IF;
  IF COALESCE(cardinality(p_note_ids),0) < 1 OR cardinality(p_note_ids)>100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 notes';
  END IF;
  v_rate := public.partner_note_rate('agent',now());
  WITH ids AS (SELECT DISTINCT unnest(p_note_ids) AS id), base AS (
    SELECT i.id AS note_id,n.partner_name,n.agent_id,p.full_name AS agent_name,p.phone AS agent_phone,
      COALESCE(n.approval_bonus_paid,false) AS already_paid,n.partner_user_id,
      EXISTS(SELECT 1 FROM public.v_pso_officers o WHERE o.user_id=n.agent_id) AS is_pso,
      COALESCE((SELECT sum(pi.amount) FROM public.promissory_note_plan_intents pi
        WHERE pi.note_id=i.id AND pi.status='reserved'),0) AS attached_amount,
      COALESCE((SELECT count(*) FROM public.promissory_note_plan_intents pi
        WHERE pi.note_id=i.id AND pi.status='reserved'),0) AS attached_plans,
      n.id IS NOT NULL AS found
    FROM ids i LEFT JOIN public.promissory_notes n ON n.id=i.id LEFT JOIN public.profiles p ON p.id=n.agent_id
  ), amounts AS (
    SELECT b.*, CASE WHEN already_paid OR is_pso THEN 0 ELSE COALESCE(v_rate,0) END AS payout_amount,
      CASE WHEN attached_plans>0 AND partner_user_id IS NOT NULL
        THEN public.get_user_available_balance(partner_user_id) ELSE 0 END AS partner_available
    FROM base b
  ), checked AS (
    SELECT a.*,CASE
      WHEN NOT found THEN 'Promissory note no longer exists'
      WHEN already_paid THEN 'Already approved and paid'
      WHEN agent_id IS NULL THEN 'No proxy agent linked'
      WHEN NOT is_pso AND COALESCE(v_rate,0)<=0 THEN 'No agent bonus rate in force'
      WHEN attached_plans>0 AND partner_user_id IS NULL THEN 'Attached Rent Plans require a registered partner'
      WHEN attached_amount>partner_available THEN 'Partner wallet is short for attached Rent Plans'
      ELSE NULL END AS blocked_reason
    FROM amounts a
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'note_id',note_id,'partner_name',partner_name,'agent_id',agent_id,'agent_name',agent_name,
    'agent_phone',agent_phone,'payout_amount',payout_amount,'pso_bonus_excluded',is_pso,
    'attached_plans',attached_plans,'attached_amount',attached_amount,
    'blocked_reason',blocked_reason,'eligible',blocked_reason IS NULL
  ) ORDER BY note_id),'[]'::jsonb) INTO v_rows FROM checked;
  RETURN jsonb_build_object('notes',v_rows,'as_at',now());
END;
$$;
REVOKE ALL ON FUNCTION public.preview_promissory_note_approvals(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_promissory_note_approvals(uuid[]) TO authenticated,service_role;
COMMENT ON FUNCTION public.preview_promissory_note_approvals(uuid[]) IS 'Read-only approval preview; reuses live agent bonus rate and PSO exclusion. All payouts remain in approve_promissory_note.';