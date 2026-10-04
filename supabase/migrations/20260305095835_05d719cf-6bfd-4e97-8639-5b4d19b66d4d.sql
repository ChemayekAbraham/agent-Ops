-- Link orphaned investor_portfolios to their activated users
UPDATE investor_portfolios ip
SET investor_id = si.activated_user_id
FROM supporter_invites si
WHERE ip.invite_id = si.id
  AND ip.investor_id IS NULL
  AND si.activated_user_id IS NOT NULL;