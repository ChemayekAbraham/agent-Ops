ALTER TABLE public.daily_wallet_reports
  ADD COLUMN run_window text NOT NULL DEFAULT 'full_day'
    CHECK (run_window IN ('full_day','morning','midday','evening'));

ALTER TABLE public.daily_wallet_reports
  DROP CONSTRAINT IF EXISTS daily_wallet_reports_report_date_key;

ALTER TABLE public.daily_wallet_reports
  ADD CONSTRAINT daily_wallet_reports_report_date_window_key
    UNIQUE (report_date, run_window);

DROP INDEX IF EXISTS public.idx_daily_wallet_reports_date;
CREATE INDEX idx_daily_wallet_reports_date_window
  ON public.daily_wallet_reports (report_date DESC, run_window);

ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'report_generation_failed';