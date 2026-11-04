-- Removes the partner statement functions. Nothing else depends on them.
DROP FUNCTION IF EXISTS public.get_partner_statement(uuid);
DROP FUNCTION IF EXISTS public._partner_statement_build(uuid);
