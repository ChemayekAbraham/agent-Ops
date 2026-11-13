-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121130000_direct_pay_phase5_agent_receipt.sql. Refuses once an agent has recorded a receipt.

SET lock_timeout = '5s';

DO $guard$
DECLARE v_any boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'funder_offplatform_rent_payments' AND column_name = 'landlord_receipt_number') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments WHERE landlord_receipt_number IS NOT NULL)' INTO v_any;
    IF v_any THEN RAISE EXCEPTION 'rollback refused: agents have recorded landlord receipts'; END IF;
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.direct_pay_agent_record_receipt(uuid, text, text);
DROP FUNCTION IF EXISTS public.direct_pay_agent_items(integer);
ALTER TABLE public.funder_offplatform_rent_payments
  DROP COLUMN IF EXISTS landlord_receipt_number,
  DROP COLUMN IF EXISTS landlord_receipt_photo_path,
  DROP COLUMN IF EXISTS landlord_receipt_recorded_at;
