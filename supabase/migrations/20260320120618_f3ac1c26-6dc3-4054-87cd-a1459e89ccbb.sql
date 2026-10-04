
-- Allow investors (supporters) to update their own portfolio's account_name
CREATE POLICY "Investors can update own account_name"
  ON public.investor_portfolios
  FOR UPDATE
  TO authenticated
  USING (investor_id = auth.uid())
  WITH CHECK (investor_id = auth.uid());

-- Also allow agents to update account_name on portfolios they created
CREATE POLICY "Agents can update own portfolios"
  ON public.investor_portfolios
  FOR UPDATE
  TO authenticated
  USING (agent_id = auth.uid())
  WITH CHECK (agent_id = auth.uid());
