-- lovable-cron-fallback-reviewed: 96 runs/day; league tiles are a live daytime collection dashboard read by 400+ collectors, and the stored daily aggregate has no event-driven writer, so a 15-minute reconciliation backstop is the shortest acceptable staleness window.
SELECT public.reconcile_agent_team_daily_stats(
  (timezone('Africa/Kampala', now()))::date - 30,
  (timezone('Africa/Kampala', now()))::date
);

SELECT cron.schedule(
  'refresh-agent-team-daily-collection-stats',
  '*/15 * * * *',
  $$SELECT public.reconcile_agent_team_daily_stats(
      (timezone('Africa/Kampala', now()))::date - 2,
      (timezone('Africa/Kampala', now()))::date
    );$$
);