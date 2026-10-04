CREATE TABLE public.cashout_claim_comments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_id UUID NOT NULL REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name TEXT,
  author_role TEXT,
  comment TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_cashout_claim_comments_withdrawal ON public.cashout_claim_comments(withdrawal_id, created_at DESC);

GRANT SELECT, INSERT ON public.cashout_claim_comments TO authenticated;
GRANT ALL ON public.cashout_claim_comments TO service_role;

ALTER TABLE public.cashout_claim_comments ENABLE ROW LEVEL SECURITY;

-- Read: finance/ops roles, or the cash-out agent assigned to this claim.
CREATE POLICY "Finance ops and assigned agent can read claim comments"
ON public.cashout_claim_comments
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (
    SELECT 1
    FROM public.withdrawal_requests wr
    JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
    WHERE wr.id = cashout_claim_comments.withdrawal_id
      AND ca.agent_id = auth.uid()
  )
);

-- Insert: same set of authors; the row's author_id must be the caller.
CREATE POLICY "Finance ops and assigned agent can add claim comments"
ON public.cashout_claim_comments
FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1
      FROM public.withdrawal_requests wr
      JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
      WHERE wr.id = cashout_claim_comments.withdrawal_id
        AND ca.agent_id = auth.uid()
    )
  )
);