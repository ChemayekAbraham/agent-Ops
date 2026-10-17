-- Run after 20261018040001. The app and PostgREST must not read or write this
-- table, so all grants to anon and authenticated are removed.

REVOKE ALL ON public.manual_verified_tids FROM anon, authenticated;
