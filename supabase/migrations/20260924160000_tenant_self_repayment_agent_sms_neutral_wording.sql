-- Handover 122: the agent SMS sent by settle_tenant_rent_from_deposit() when a
-- tenant pays rent directly said "<name> paid his own rent ... His rent
-- balance ... No collection needed from him", regardless of the tenant. It
-- went out as e.g. "Martha Namigadde paid his own rent". Make it neutral.
--
-- Patches the LIVE function body in place rather than restating it: this
-- function has been redefined by several migrations (most recently
-- 20260924100000) and the repo copy is not guaranteed to match production.
-- Only the SMS copy changes; the DO block refuses to run if any expected
-- phrase is missing, so it can never silently rewrite anything else.

do $mig$
declare
  v_sig  regprocedure := 'public.settle_tenant_rent_from_deposit(uuid)'::regprocedure;
  v_def  text := pg_get_functiondef(v_sig);
  v_new  text;
begin
  if position('paid his own rent' in v_def) = 0
     or position('His rent balance: UGX %s.' in v_def) = 0
     or position('No collection needed from him until %s.' in v_def) = 0 then
    raise exception 'settle_tenant_rent_from_deposit: expected agent SMS wording not found; refusing to patch';
  end if;

  v_new := v_def;
  -- covers both "paid his own rent" and "part-paid his own rent"
  v_new := replace(v_new, 'paid his own rent', 'paid their rent directly');
  v_new := replace(v_new, 'His rent balance: UGX %s.', 'Rent balance: UGX %s.');
  v_new := replace(v_new, 'No collection needed from him until %s.', 'No collection needed until %s.');

  execute v_new;
end
$mig$;
