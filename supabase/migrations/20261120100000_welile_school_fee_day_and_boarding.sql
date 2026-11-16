-- Welile Schools: a class fee can be "Day and boarding" — one fee that applies to both day and
-- boarding students in that class — besides "Day" and "Boarding".
-- A class cannot have a "Day and boarding" fee and also a separate day or boarding fee in the same term.

alter table public.welile_school_fee_structures
  drop constraint if exists welile_school_fee_structures_boarding_status_check;
alter table public.welile_school_fee_structures
  add constraint welile_school_fee_structures_boarding_status_check
  check (boarding_status = any (array['day'::text, 'boarding'::text, 'day_and_boarding'::text]));

-- CREATE OR REPLACE keeps the existing grants on this function.
create or replace function public.welile_school_term_save(p_school_id uuid, p_term_id uuid, p_name text, p_start_date date, p_end_date date, p_fees jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_term uuid;
  v_fee jsonb;
  v_class text;
  v_boarding text;
  v_amount numeric;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_school_partnership_editable(p_school_id) then
    raise exception 'PARTNERSHIP_LOCKED' using hint = 'Only the school''s agent can edit a draft, or ops at any time.';
  end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Enter the term name'; end if;
  if p_start_date is null or p_end_date is null then raise exception 'Enter the term start and end dates'; end if;
  if p_end_date < p_start_date + 28 then raise exception 'A term must be at least 4 weeks long'; end if;
  if p_end_date > p_start_date + 200 then raise exception 'A term cannot be longer than 200 days'; end if;
  if jsonb_typeof(coalesce(p_fees,'null'::jsonb)) <> 'array' or jsonb_array_length(p_fees) = 0 then
    raise exception 'Add at least one class fee';
  end if;

  if p_term_id is null then
    insert into public.welile_school_terms (school_id, name, start_date, end_date, created_by)
    values (p_school_id, trim(p_name), p_start_date, p_end_date, v_uid)
    returning id into v_term;
  else
    update public.welile_school_terms
       set name = trim(p_name), start_date = p_start_date, end_date = p_end_date, updated_at = now()
     where id = p_term_id and school_id = p_school_id
    returning id into v_term;
    if v_term is null then raise exception 'TERM_NOT_FOUND'; end if;
    delete from public.welile_school_fee_structures where term_id = v_term;
  end if;

  for v_fee in select * from jsonb_array_elements(p_fees) loop
    v_class    := trim(coalesce(v_fee->>'class_name',''));
    v_boarding := coalesce(v_fee->>'boarding_status','day');
    v_amount   := nullif(v_fee->>'amount','')::numeric;
    if length(v_class) = 0 then raise exception 'Every fee needs a class'; end if;
    if v_boarding not in ('day','boarding','day_and_boarding') then
      raise exception 'Boarding status must be day, boarding, or day and boarding';
    end if;
    if v_amount is null or v_amount <= 0 then raise exception 'Fee for % must be more than 0', v_class; end if;
    if exists (
      select 1 from public.welile_school_fee_structures s
       where s.term_id = v_term and lower(s.class_name) = lower(v_class)
         and (s.boarding_status = 'day_and_boarding') <> (v_boarding = 'day_and_boarding')
    ) then
      raise exception '% has a "Day and boarding" fee and a separate day or boarding fee; keep one', v_class;
    end if;
    insert into public.welile_school_fee_structures (term_id, class_name, boarding_status, amount)
    values (v_term, v_class, v_boarding, round(v_amount, 2));
  end loop;

  return v_term;
exception
  when unique_violation then
    raise exception 'A term with this name, or a duplicate class fee, already exists';
end;
$function$;
