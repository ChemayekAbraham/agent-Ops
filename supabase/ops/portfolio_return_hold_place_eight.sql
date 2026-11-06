-- Place the portfolio Return hold on the eight CFO-proposed portfolios.               NOT RUN — needs CFO approval.
-- Prerequisite: migration 20261024160000_portfolio_return_hold applied. This file is NOT a migration.
--
-- Preferred route: the CFO approver calls place_portfolio_return_hold from their own signed-in session (a small CFO
-- screen action, to be added by the UI owner). The fallback below runs in the SQL editor and acts AS the CFO approver
-- (it sets the request user to the CFO's id, as the API does); run it only with the CFO present and approving, because
-- the audit log will record the CFO as the person who placed each hold.
--
-- Replace <CFO_APPROVER_UUID> before running. Each step is separate; stop if a check fails.

-- 1. Pre-flight (read-only): every portfolio exists, is active, is not already held, has no open request, no parked
--    top-up, no auto-reinvest with rent-facilitation rewards. Expect 8 rows, all checks true.
BEGIN TRANSACTION READ ONLY;
WITH p(code) AS (VALUES ('WIP2604269303'), ('WIP2608107391'), ('WIP2607014488'), ('WIP2504171628'),
                        ('WIP2507088914'), ('WIP2604094960'), ('WPF-6422'), ('WIP2607082735'))
SELECT ip.portfolio_code, ip.id, ip.status = 'active' AS active, NOT public.is_portfolio_on_hold(ip.id) AS not_held,
       NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o WHERE o.source_id = ip.id
                    AND o.status NOT IN ('approved','rejected','cancelled','completed','failed')) AS no_open_request,
       NOT (ip.auto_reinvest AND EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.supporter_id = ip.investor_id
                    AND r.status IN ('funded','disbursed','active','repaying'))) AS no_reward_reinvest_risk,
       ip.next_roi_date
  FROM p JOIN public.investor_portfolios ip ON ip.portfolio_code = p.code ORDER BY 1;
ROLLBACK;

-- 2. Placement (fallback route; one transaction; all eight or none).
BEGIN;
SELECT set_config('request.jwt.claim.sub', '<CFO_APPROVER_UUID>', true);
SET LOCAL ROLE authenticated;
SELECT public.place_portfolio_return_hold(id, reason) FROM (VALUES
  ('f7273892-b6a1-4561-bcc4-06b21f195458'::uuid, 'CFO review 2026-10: unsupported principal edits, early and duplicate compounds; Return due 25 Oct held pending capital evidence'),
  ('3d158d95-54e6-45a3-9e2c-347553f0714e'::uuid, 'CFO review 2026-10: funding from staff float, backdated start, duplicate compound and cash Returns'),
  ('5733b5d2-6873-4003-9a5e-53f5c024ba91'::uuid, 'CFO review 2026-10: unsupported principal edit, early and duplicate compound, funding from expense-coded credit'),
  ('6009c93c-c504-4a13-be2f-510851322087'::uuid, 'CFO review 2026-10: confirmed duplicate compound and early compounds'),
  ('ff8d9156-d737-4a16-aa2e-ff1df431982d'::uuid, 'CFO review 2026-10: compound and cash Return posted for the same cycle twice'),
  ('6a5fa223-5ede-44ef-8fdc-5098f1217b82'::uuid, 'CFO review 2026-10: compounds posted ahead of three cycles'),
  ('d5124335-d9b9-48f9-ac9d-571bb28df25c'::uuid, 'CFO review 2026-10: portfolio owned by the managing staff account; staff self-edits under review'),
  ('84d3c844-2f9d-45ae-b67a-4eac159909a3'::uuid, 'CFO review 2026-10: portfolio owned by the managing staff account; early compounds under review')
) AS h(id, reason);
COMMIT;

-- 3. Post-check (read-only): expect 8 active holds and 8 audit rows.
BEGIN TRANSACTION READ ONLY;
SELECT p.portfolio_code, h.held_at, h.held_by FROM public.portfolio_return_holds h
  JOIN public.investor_portfolios p ON p.id = h.portfolio_id WHERE h.released_at IS NULL ORDER BY 1;
SELECT count(*) AS audit_rows FROM public.audit_logs WHERE action_type = 'portfolio_return_hold_placed' AND created_at > now() - interval '1 hour';
ROLLBACK;

-- Release (one portfolio; CFO approver; reason of 20+ characters):
--   select public.release_portfolio_return_hold('<portfolio uuid>', '<reason>');
