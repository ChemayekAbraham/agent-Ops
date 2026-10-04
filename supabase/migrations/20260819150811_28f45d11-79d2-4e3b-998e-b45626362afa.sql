GRANT SELECT ON public.agent_advance_ledger TO authenticated;
GRANT ALL ON public.agent_advance_ledger TO service_role;

DROP POLICY IF EXISTS "Agents can view own advance ledger" ON public.agent_advance_ledger;
CREATE POLICY "Agents can view own advance ledger"
ON public.agent_advance_ledger
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.agent_advances a
    WHERE a.id = agent_advance_ledger.advance_id
      AND a.agent_id = auth.uid()
  )
);