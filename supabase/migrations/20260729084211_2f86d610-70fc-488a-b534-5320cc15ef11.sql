INSERT INTO public.system_config (key, value, updated_at)
VALUES ('agent_perf_gate_disabled_until', to_jsonb((now() + interval '1 hour')::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();