-- tenant_ratings: no frontend reads this table today; scope reads to the two
-- parties on the rating plus operations roles instead of every signed-in user.
DROP POLICY IF EXISTS "Signed-in users can view tenant ratings" ON public.tenant_ratings;
CREATE POLICY "Rating parties and ops can view tenant ratings"
ON public.tenant_ratings
FOR SELECT
TO authenticated
USING (
  auth.uid() = tenant_id
  OR auth.uid() = landlord_id
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'tenant_ops'::app_role)
  OR public.has_role(auth.uid(), 'landlord_ops'::app_role)
  OR public.has_role(auth.uid(), 'agent_ops'::app_role)
);

-- review_responses: agent replies shown publicly under marketplace reviews.
-- Keep them readable, but only when the parent review still exists (a real
-- predicate instead of a blanket USING (true)).
DROP POLICY IF EXISTS "Signed-in users can view review responses" ON public.review_responses;
CREATE POLICY "Signed-in users can view responses on existing reviews"
ON public.review_responses
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.product_reviews pr WHERE pr.id = review_responses.review_id
  )
);