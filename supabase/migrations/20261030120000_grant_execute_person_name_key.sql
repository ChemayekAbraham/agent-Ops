-- The expression indexes added in 20261029120000 call person_name_key() whenever a profiles row is updated, as the
-- user doing the update. person_name_key was closed by default (owner + service_role only), so from 11:25 UTC every
-- profiles UPDATE by a signed-in user (the last_active_at heartbeat) failed with "permission denied for function
-- person_name_key" (311 refusals until the grant). It is a pure IMMUTABLE text helper, so open it to the API roles.
-- Applied to production by hand; this file is the record.
grant execute on function public.person_name_key(text) to authenticated, anon;
