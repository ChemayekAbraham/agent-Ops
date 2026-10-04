ALTER FUNCTION public.run_finance_anomaly_scan(text) SET statement_timeout = '180s';
ALTER FUNCTION public.detect_finance_anomalies(numeric) SET statement_timeout = '180s';