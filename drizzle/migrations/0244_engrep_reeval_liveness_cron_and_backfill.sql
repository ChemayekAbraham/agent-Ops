select cron.schedule(
  'engrep-reeval-liveness-1730-eat',
  '30 14 * * *',
  $$select public.engrep_reevaluate_liveness((current_date - 3));$$
);

do $$
declare d date;
begin
  for d in
    select generate_series(date '2026-09-10', current_date - 3, interval '1 day')::date
  loop
    perform public.engrep_reevaluate_liveness(d);
  end loop;
end $$;