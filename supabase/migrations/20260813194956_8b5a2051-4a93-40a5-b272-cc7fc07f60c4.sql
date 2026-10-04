-- National ID stays mandatory for new applicants (enforced in accept_proxy_agreement),
-- but grandfathered rows for already-working proxies must not need a fake value.
ALTER TABLE public.proxy_agent_identity ALTER COLUMN nin DROP NOT NULL;

-- Grandfather every proxy agent currently linked to a lead partner
INSERT INTO public.proxy_agent_identity
  (agent_user_id, nin, full_name, phone, status, submitted_at, reviewed_at, review_notes)
SELECT DISTINCT a.agent_id, NULL, p.full_name, p.phone, 'approved', a.attached_at, now(),
       'Grandfathered: already linked to a lead partner before the approval gate'
  FROM public.partner_lead_assignments a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
 WHERE a.detached_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.proxy_agent_identity i WHERE i.agent_user_id = a.agent_id
   )
ON CONFLICT (agent_user_id) DO NOTHING;