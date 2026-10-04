
CREATE TABLE public.agent_form_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  max_uses int NOT NULL DEFAULT 50,
  uses_count int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_form_tokens_agent ON public.agent_form_tokens(agent_id);
CREATE INDEX idx_agent_form_tokens_token ON public.agent_form_tokens(token);

ALTER TABLE public.agent_form_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view their own tokens"
  ON public.agent_form_tokens FOR SELECT
  TO authenticated
  USING (auth.uid() = agent_id);

CREATE POLICY "Agents can create their own tokens"
  ON public.agent_form_tokens FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = agent_id);
