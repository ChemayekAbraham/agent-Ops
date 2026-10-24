-- 2026-10-25: Supabase performance lint (auth_rls_initplan) on public.hr_pay_prompts policy hr_pay_prompts_read.
-- approver_id = auth.uid() re-evaluated auth.uid() per candidate row; wrapping it in a scalar select lets Postgres evaluate it once per query (initPlan).
-- Same access rule: a row is readable only when approver_id is the caller. Applied to production 2026-10-25.
alter policy hr_pay_prompts_read on public.hr_pay_prompts using (approver_id = (select auth.uid()));
