ALTER TABLE public.agent_subagents
  ADD COLUMN IF NOT EXISTS invite_sms_status text,
  ADD COLUMN IF NOT EXISTS invite_email_status text,
  ADD COLUMN IF NOT EXISTS invite_sent_at timestamp with time zone;

COMMENT ON COLUMN public.agent_subagents.invite_sms_status IS 'Delivery status of the invite SMS: sent | failed | not_sent';
COMMENT ON COLUMN public.agent_subagents.invite_email_status IS 'Delivery status of the invite email: sent | failed | not_sent';