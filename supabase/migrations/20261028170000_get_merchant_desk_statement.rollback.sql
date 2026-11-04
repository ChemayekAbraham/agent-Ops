-- Removes the merchant desk statement. Nothing else uses it except the Android "Desk statement" screen, which then shows an error.

DROP FUNCTION IF EXISTS public.get_merchant_desk_statement(uuid, date);
