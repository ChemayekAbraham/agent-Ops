DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'hr_ticket_severity'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.hr_ticket_severity AS ENUM ('critical', 'high', 'normal');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'hr_ticket_origin'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.hr_ticket_origin AS ENUM ('internal', 'external');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'hr_reporter_channel'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.hr_reporter_channel AS ENUM ('phone', 'whatsapp', 'email', 'in_person', 'in_app');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'hr_difficulty_band'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.hr_difficulty_band AS ENUM ('w1', 'w2', 'w3', 'w4', 'w5');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'hr_quality'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.hr_quality AS ENUM ('excellent', 'good', 'fair', 'poor', 'not_delivered');
  END IF;
END $$;

ALTER TYPE public.hr_task_event_type ADD VALUE IF NOT EXISTS 'claimed' AFTER 'assigned';
ALTER TYPE public.hr_task_event_type ADD VALUE IF NOT EXISTS 'returned' AFTER 'unblocked';
