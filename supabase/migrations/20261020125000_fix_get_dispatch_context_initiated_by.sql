-- 2026-10-20 (doc 247, step 34): get_dispatch_context read v_w.metadata->>'initiated_by', but withdrawal_requests has no metadata column
-- (it has initiated_by), so every call raised "record v_w has no field metadata" (about 49 errors in one hour). Use the real column.
-- Idempotent: edits the live definition in place; grants are unchanged (authenticated yes, anon no). Applied to production 2026-10-20.
do $do$
declare d text := pg_get_functiondef('public.get_dispatch_context(uuid)'::regprocedure);
  o text := 'lower(coalesce(v_w.metadata->>''initiated_by'', ''''))';
  n text := 'lower(coalesce(v_w.initiated_by::text, ''''))';
begin
  if position(n in d) > 0 then return; end if;
  if position(o in d) = 0 then raise exception 'get_dispatch_context pattern not found'; end if;
  execute replace(d, o, n);
end $do$;
