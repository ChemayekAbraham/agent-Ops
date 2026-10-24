-- Stop MTN payments from ROBERT MUGISHA being credited to the wrong same-name profile.
--
-- Two profiles are named Robert Mugisha:
--   86eb32d3-43a5-462b-b698-186b83cec8d0  (+256794402225)  holds the Rent Plan, the real payer
--   dc676bca-c64b-450c-96d3-2928cf821bc2  (+256779166640)  duplicate, never had a payment of its own
-- The MTN receipt carries only the name, so gmail-poll-transactions used to pick the most
-- recently active of the two. It picked the wrong one seven times (8, 15, 19, 21, 22 and 24 Oct).
--
-- The poller no longer guesses between same-name profiles. A same-name receipt is only
-- auto-credited when the name is confirmed in user_deposit_names for exactly one of the
-- candidate profiles and has never been contested. This row is that confirmation: the account
-- holder confirmed that all payments from this name are his, and the Rent Plan is on this profile.
-- Any other same-name payment is left unmatched for Financial Ops to route.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.user_deposit_names (user_id, normalized_name, source, contested)
SELECT '86eb32d3-43a5-462b-b698-186b83cec8d0'::uuid, 'ROBERT MUGISHA', 'manual_route', false
WHERE EXISTS (SELECT 1 FROM public.profiles WHERE id = '86eb32d3-43a5-462b-b698-186b83cec8d0')
ON CONFLICT (user_id, normalized_name) DO UPDATE SET contested = false;
