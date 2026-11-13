select pg_get_triggerdef(t.oid) d, case when t.tgenabled='D' then format('ALTER TABLE public.%I DISABLE TRIGGER %I', c.relname, t.tgname) end dis
from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal
