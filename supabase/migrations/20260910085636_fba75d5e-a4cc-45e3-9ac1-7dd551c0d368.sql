create index if not exists engrep_catalog_snapshot_day_idx
  on public.engrep_catalog_snapshot (captured_for);

select cron.schedule(
  'engrep-prune-catalog-snapshot',
  '45 14 * * *',
  $$delete from public.engrep_catalog_snapshot
    where captured_for < ((now() at time zone 'Africa/Kampala')::date - 90);$$
);