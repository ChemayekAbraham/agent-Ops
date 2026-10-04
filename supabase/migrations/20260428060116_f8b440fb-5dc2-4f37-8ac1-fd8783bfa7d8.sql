ALTER TABLE public.repayments
  DROP CONSTRAINT repayments_rent_request_id_fkey,
  ADD CONSTRAINT repayments_rent_request_id_fkey
    FOREIGN KEY (rent_request_id)
    REFERENCES public.rent_requests(id)
    ON DELETE NO ACTION;