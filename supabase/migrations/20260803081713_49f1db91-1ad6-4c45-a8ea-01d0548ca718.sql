-- 1. HR bank secrets: fail-closed + explicit admin-only read, and no anon access
REVOKE ALL ON public.hr_pay_bank_secrets FROM anon;
REVOKE ALL ON public.hr_pay_bank_secrets FROM PUBLIC;
GRANT SELECT ON public.hr_pay_bank_secrets TO authenticated;
GRANT ALL ON public.hr_pay_bank_secrets TO service_role;
DROP POLICY IF EXISTS "Payroll rule admins can read bank secrets" ON public.hr_pay_bank_secrets;
CREATE POLICY "Payroll rule admins can read bank secrets"
ON public.hr_pay_bank_secrets FOR SELECT TO authenticated
USING (public.hr_pay_is_rule_admin());

-- 2. investor_portfolios: remove header-guessable anon read (unused by the app)
DROP POLICY IF EXISTS "Anon can select by specific activation_token" ON public.investor_portfolios;
REVOKE ALL ON public.investor_portfolios FROM anon;

-- 3. promissory_notes: remove permanently-dead anon policy
DROP POLICY IF EXISTS "Anon can lookup by activation token" ON public.promissory_notes;
REVOKE ALL ON public.promissory_notes FROM anon;

-- 4. Reviews / questions / ratings: identities no longer readable by anonymous visitors
DROP POLICY IF EXISTS "Anyone can view reviews" ON public.user_reviews;
CREATE POLICY "Signed-in users can view user reviews"
ON public.user_reviews FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view house reviews" ON public.house_reviews;
CREATE POLICY "Signed-in users can view house reviews"
ON public.house_reviews FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view house questions" ON public.house_questions;
CREATE POLICY "Signed-in users can view house questions"
ON public.house_questions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view votes" ON public.review_votes;
CREATE POLICY "Signed-in users can view review votes"
ON public.review_votes FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view review responses" ON public.review_responses;
CREATE POLICY "Signed-in users can view review responses"
ON public.review_responses FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view ratings" ON public.tenant_ratings;
CREATE POLICY "Signed-in users can view tenant ratings"
ON public.tenant_ratings FOR SELECT TO authenticated USING (true);

REVOKE SELECT ON public.user_reviews FROM anon;
REVOKE SELECT ON public.house_reviews FROM anon;
REVOKE SELECT ON public.house_questions FROM anon;
REVOKE SELECT ON public.review_votes FROM anon;
REVOKE SELECT ON public.review_responses FROM anon;
REVOKE SELECT ON public.tenant_ratings FROM anon;