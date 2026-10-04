CREATE TABLE public.agent_recommendation_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_for uuid NOT NULL,
  generated_by uuid,
  tier text,
  response_rate numeric,
  reason_codes text[] NOT NULL DEFAULT '{}',
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.agent_recommendation_audit TO authenticated;
GRANT ALL ON public.agent_recommendation_audit TO service_role;

ALTER TABLE public.agent_recommendation_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inserter records own generation"
  ON public.agent_recommendation_audit
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = generated_by);

CREATE POLICY "Agent or generator can read their recommendation audit"
  ON public.agent_recommendation_audit
  FOR SELECT TO authenticated
  USING (auth.uid() = generated_for OR auth.uid() = generated_by);

CREATE POLICY "Ops roles can read all recommendation audit"
  ON public.agent_recommendation_audit
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

CREATE INDEX idx_agent_recommendation_audit_for_time
  ON public.agent_recommendation_audit (generated_for, generated_at DESC);