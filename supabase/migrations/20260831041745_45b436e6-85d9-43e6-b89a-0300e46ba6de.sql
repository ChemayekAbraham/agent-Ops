CREATE TABLE public.proxy_partner_contact_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  partner_user_id uuid,
  partner_name text,
  partner_phone text,
  note_id uuid,
  channel text NOT NULL DEFAULT 'note',
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proxy_partner_contact_logs_channel_ck CHECK (channel IN ('whatsapp','call','note')),
  CONSTRAINT proxy_partner_contact_logs_body_ck CHECK (length(btrim(body)) > 0)
);

CREATE INDEX proxy_partner_contact_logs_agent_idx ON public.proxy_partner_contact_logs (agent_id, created_at DESC);
CREATE INDEX proxy_partner_contact_logs_partner_idx ON public.proxy_partner_contact_logs (agent_id, partner_user_id, created_at DESC);
CREATE INDEX proxy_partner_contact_logs_phone_idx ON public.proxy_partner_contact_logs (agent_id, partner_phone, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.proxy_partner_contact_logs TO authenticated;
GRANT ALL ON public.proxy_partner_contact_logs TO service_role;

ALTER TABLE public.proxy_partner_contact_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own contact logs"
  ON public.proxy_partner_contact_logs FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Agents add own contact logs"
  ON public.proxy_partner_contact_logs FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents edit own contact logs"
  ON public.proxy_partner_contact_logs FOR UPDATE TO authenticated
  USING (agent_id = auth.uid()) WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents delete own contact logs"
  ON public.proxy_partner_contact_logs FOR DELETE TO authenticated
  USING (agent_id = auth.uid());