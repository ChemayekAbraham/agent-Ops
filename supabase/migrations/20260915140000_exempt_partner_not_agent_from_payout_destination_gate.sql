-- Fix: the previous migration (20260915130000) added
-- public.is_partner_not_agent() and wired it into withdrawal_user_id_verified(),
-- but that function is NOT the gate that actually blocks self-withdrawal.
--
-- The real self-withdrawal choke point is public.ensure_payout_destination(),
-- called directly by both submit_withdrawal_request() and the
-- issue-wallet-withdrawal-otp edge function. Both reject with
-- 'destination_unverified' whenever payout_destination_verifications.status
-- <> 'verified' for that exact destination_key, with no exemption bypass at
-- all. withdrawal_user_id_verified() is only consulted elsewhere (the
-- merchant-claim gate), so the previous fix never reached self-withdrawal.
--
-- Confirmed against production 2026-09-15: partner Simon Kavuma
-- (2cab68aa-108a-4d50-8168-a4eef15f097c, phone 0766156243, has 2 active
-- investor_portfolios, no agent_collections/rent_requests as agent) tried a
-- self-withdrawal and got two payout_destination_verifications rows stuck at
-- status='waiting' (momo:766156243 and momo:742203130), even though the prior
-- migration was live.
--
-- (is_partner_not_agent is re-created here defensively in case the prior
-- migration file was never actually applied to this database — this file
-- must not depend on that assumption.)
CREATE OR REPLACE FUNCTION public.is_partner_not_agent(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    exists (select 1 from public.investor_portfolios ip where ip.investor_id = p_user_id)
    and not exists (select 1 from public.agent_collections ac where ac.agent_id = p_user_id)
    and not exists (
      select 1 from public.rent_requests rr
      where rr.agent_id = p_user_id
         or rr.assigned_agent_id = p_user_id
         or rr.proxy_agent_id = p_user_id
    )
$function$;

REVOKE ALL ON FUNCTION public.is_partner_not_agent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_partner_not_agent(uuid) TO authenticated, service_role;

-- Auto-verify a destination for an exempt partner instead of dropping it into
-- the manual 'waiting' queue. Never touches an already-'rejected' row — a
-- Financial Ops rejection stands regardless of exemption status. Never
-- reopens a 'verified' row to 'waiting' on a name change for an exempt user
-- either, since re-verification is exactly what the exemption skips.
CREATE OR REPLACE FUNCTION public.ensure_payout_destination(p_user_id uuid, p_method text, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, decision_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
  v_type text := CASE WHEN lower(coalesce(p_method,'')) = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END;
  v_name text := coalesce(nullif(btrim(coalesce(p_momo_name,'')), ''), nullif(btrim(coalesce(p_bank_account_name,'')), ''));
  v_id uuid;
  v_status text;
  v_reason text;
  v_prev_name text;
  v_id_name text;
  v_nid text;
  v_report jsonb;
  v_exempt boolean := public.is_partner_not_agent(p_user_id);
BEGIN
  IF v_key IS NULL THEN
    RETURN;
  END IF;

  SELECT p.national_id, coalesce(p.national_id_name, p.full_name)
    INTO v_nid, v_id_name
  FROM public.profiles p WHERE p.id = p_user_id;

  v_report := public.payout_name_match_report(v_id_name, v_name);

  SELECT d.id, d.status, d.account_name INTO v_id, v_status, v_prev_name
  FROM public.payout_destination_verifications d
  WHERE d.user_id = p_user_id AND d.destination_key = v_key;

  IF v_id IS NULL THEN
    INSERT INTO public.payout_destination_verifications (
      user_id, destination_type, destination_key, provider,
      momo_number, bank_name, bank_account_number, account_name,
      national_id, national_id_name, name_match_score, name_mismatch_tokens,
      status, decision_reason
    ) VALUES (
      p_user_id, v_type, v_key,
      CASE WHEN v_type = 'mobile_money' THEN lower(coalesce(p_provider,'')) ELSE 'bank' END,
      CASE WHEN v_type = 'mobile_money' THEN btrim(p_momo_number) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_name) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_account_number) END,
      v_name, v_nid, v_id_name,
      (v_report->>'score')::numeric, coalesce(v_report->'diff', '[]'::jsonb),
      CASE WHEN v_exempt THEN 'verified' ELSE 'waiting' END,
      CASE WHEN v_exempt THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.' ELSE NULL END
    )
    RETURNING payout_destination_verifications.id, payout_destination_verifications.status,
              payout_destination_verifications.decision_reason
      INTO v_id, v_status, v_reason;
  ELSE
    UPDATE public.payout_destination_verifications d
    SET account_name = coalesce(v_name, d.account_name),
        national_id = coalesce(v_nid, d.national_id),
        national_id_name = coalesce(v_id_name, d.national_id_name),
        name_match_score = (v_report->>'score')::numeric,
        name_mismatch_tokens = coalesce(v_report->'diff', '[]'::jsonb),
        status = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'verified'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND lower(coalesce(v_prev_name,'')) <> lower(v_name)
               AND NOT v_exempt THEN 'waiting'
          ELSE d.status END,
        decision_reason = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND lower(coalesce(v_prev_name,'')) <> lower(v_name)
               AND NOT v_exempt
          THEN 'Account name changed after verification — needs re-verification'
          ELSE d.decision_reason END
    WHERE d.id = v_id
    RETURNING d.status, d.decision_reason INTO v_status, v_reason;
  END IF;

  RETURN QUERY SELECT v_id, v_status, v_reason;
END;
$function$;

INSERT INTO public.audit_logs (action_type, table_name, reason, metadata)
VALUES (
  'withdrawal_id_verification_policy_change',
  'ensure_payout_destination',
  'Fixed the actual self-withdrawal gate: ensure_payout_destination() now auto-verifies a new/waiting destination for a partner-not-agent exempt user, instead of only exempting withdrawal_user_id_verified() which is unused on the self-withdrawal path.',
  jsonb_build_object('changed_by', 'joshua.wanda@welile.com', 'changed_at', now())
);
