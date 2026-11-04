-- profiles_email_match_idx is an expression index on normalize_email_for_match(email), so every
-- insert or update on profiles by a signed-in user runs the function as that user. The function was
-- closed by default (doc 247 step 23), which refused those writes with
-- "permission denied for function normalize_email_for_match" (69 in the log, 08:00-11:11 UTC 10-30).
-- It is a pure immutable string helper with no table access, so it is safe to open.
-- Same cause and fix as 20261030120000_grant_execute_person_name_key.sql.
grant execute on function public.normalize_email_for_match(text) to authenticated, anon;
