alter table public.seo_index_monitor_snapshots
  add column if not exists data_quality jsonb,
  add column if not exists serving_pages_count integer,
  add column if not exists serving_window_days integer,
  add column if not exists sitemap_last_downloaded timestamptz,
  add column if not exists url_samples jsonb,
  add column if not exists sampled_indexed_count integer,
  add column if not exists sampled_total_count integer,
  add column if not exists monitor_degraded boolean not null default false;

comment on column public.seo_index_monitor_snapshots.sitemap_indexed_count is
  'DEPRECATED Google field (contents[].indexed) - always 0. Never a source of truth; retained null-safe for history only.';
comment on column public.seo_index_monitor_snapshots.data_quality is
  'Per-run record of which expected GSC fields were present vs absent; drives monitor_degraded.';

alter table public.seo_index_monitor_settings
  add column if not exists sample_cursor integer not null default 0;