-- Removes the "company receipts to place" backend. Float returns already placed with it stay booked (they are ordinary returns);
-- only the list, the actions, the learned desk numbers and the dismissals go. The Android screen then shows an error.

DROP FUNCTION IF EXISTS public.get_company_receipts_to_place(integer);
DROP FUNCTION IF EXISTS public.place_company_receipt_as_float_return(uuid, uuid, boolean, text);
DROP FUNCTION IF EXISTS public.dismiss_company_receipt(uuid, text);
DROP FUNCTION IF EXISTS public.register_merchant_desk_number(uuid, text, text);
DROP FUNCTION IF EXISTS public.remove_merchant_desk_number(text);
DROP TABLE IF EXISTS public.company_receipt_dismissals;
DROP TABLE IF EXISTS public.merchant_desk_phone_numbers;
