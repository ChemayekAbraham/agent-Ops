CREATE TABLE IF NOT EXISTS public.withdrawal_id_gate_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id uuid NOT NULL UNIQUE,
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.withdrawal_id_gate_exemptions TO authenticated;
GRANT ALL ON public.withdrawal_id_gate_exemptions TO service_role;

ALTER TABLE public.withdrawal_id_gate_exemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view id gate exemptions" ON public.withdrawal_id_gate_exemptions;
CREATE POLICY "Staff can view id gate exemptions"
ON public.withdrawal_id_gate_exemptions
FOR SELECT
TO authenticated
USING (public.is_withdrawal_staff(auth.uid()));

INSERT INTO public.withdrawal_id_gate_exemptions (agent_user_id, reason)
VALUES ('5f277e34-a830-4ebb-8680-c0c074b279da', 'Approved exemption: proxy withdrawals posted by Kabahuma Lillian are visible to merchant agents while partner identity verification is completed')
ON CONFLICT (agent_user_id) DO UPDATE SET active = true, reason = EXCLUDED.reason;

CREATE OR REPLACE FUNCTION public.withdrawal_merchant_id_gate(p_user_id uuid, p_landlord_payout_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_landlord_payout_id is not null
      or coalesce(p_reason, '') like 'Landlord float payout%'
      or public.withdrawal_user_id_verified(p_user_id)
      or exists (
        select 1
        from public.withdrawal_requests w
        join public.withdrawal_id_gate_exemptions e
          on e.active
         and e.agent_user_id in (w.agent_id, w.initiated_by)
        where w.user_id = p_user_id
          and w.proxy_partner_id is not null
      )
$function$;