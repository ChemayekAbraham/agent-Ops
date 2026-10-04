alter table public.rent_requests
  add column if not exists repayment_starts_on date;

comment on column public.rent_requests.repayment_starts_on is
  'Local (Africa/Kampala) date of the first scheduled repayment instalment. Every schedule calculation must derive its term start from this column and nothing else. Backfilled to funded/disbursed date plus 1 for existing rows.';

update public.rent_requests rr
set repayment_starts_on =
  ((coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) at time zone 'Africa/Kampala')::date
   + 1)
where rr.repayment_starts_on is null
  and coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) is not null;

create or replace function public.rent_request_default_repayment_start()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.repayment_starts_on is null
     and coalesce(new.funded_at, new.disbursed_at) is not null then
    new.repayment_starts_on :=
      ((coalesce(new.funded_at, new.disbursed_at) at time zone 'Africa/Kampala')::date
       + 1);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_rent_request_default_repayment_start on public.rent_requests;
create trigger trg_rent_request_default_repayment_start
  before insert or update of funded_at, disbursed_at
  on public.rent_requests
  for each row
  execute function public.rent_request_default_repayment_start();