-- 2026-10-19 (doc 247, step 29): remove six tables from the supabase_realtime publication that nothing subscribes to.
-- Context: the exported Realtime logs (Downloads/supabase_logs.json, 09:00-10:00 UTC 19 Oct) show 261 errors out of 298 entries: "IncreaseSubscriptionConnectionPool:
-- Too many database timeouts" (195), connection-pool queue timeouts after 12 s, dropped connections. Realtime could not get database connections while the database was
-- saturated, and each failed retry adds load. 57 tables were published; no code (src/, supabase/functions/) and no live subscription uses these six:
-- gmail_transactions and user_risk_scores (written constantly), property_viewings, referrals, user_reviews, welile_homes_subscriptions.
-- Realtime decodes every change on a published table whether or not anyone listens. Applied to production 2026-10-19.
-- Undo (if a screen ever needs one): alter publication supabase_realtime add table public.<table>;
alter publication supabase_realtime drop table public.gmail_transactions, public.property_viewings, public.referrals, public.user_reviews, public.user_risk_scores, public.welile_homes_subscriptions;
