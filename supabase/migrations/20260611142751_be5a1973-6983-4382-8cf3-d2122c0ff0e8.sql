ALTER TABLE public.agent_subagents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- Backfill: pending invites get 7 days from creation; accepted invites get no expiration.
UPDATE public.agent_subagents
SET expires_at = CASE
  WHEN status = 'verified' THEN NULL
  ELSE created_at + interval '7 days'
END
WHERE expires_at IS NULL;