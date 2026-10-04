ALTER TABLE public.cfo_debit_obligations
  DROP CONSTRAINT IF EXISTS cfo_debit_obligations_status_check;

ALTER TABLE public.cfo_debit_obligations
  ADD CONSTRAINT cfo_debit_obligations_status_check
  CHECK (status = ANY (ARRAY[
    'open'::text, 'partially_recovered'::text, 'recovered'::text,
    'written_off'::text, 'reversed'::text, 'voided_phantom'::text
  ]));