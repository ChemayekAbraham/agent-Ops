CREATE TABLE public.hr_ticket_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.hr_ticket_surfaces (key, label, sort_order) VALUES
  ('wallet', 'Wallet', 10),
  ('payments', 'Payments', 20),
  ('listings', 'Listings', 30),
  ('tenancy', 'Tenancy', 40),
  ('leases', 'Leases', 50),
  ('agents', 'Agents', 60),
  ('landlords', 'Landlords', 70),
  ('reports', 'Reports', 80),
  ('auth', 'Sign-in and access', 90),
  ('other', 'Other', 100);

CREATE TABLE public.hr_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,
  raised_by uuid NOT NULL REFERENCES hr_staff(id),
  raised_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  body text NOT NULL,
  severity hr_ticket_severity NOT NULL,
  severity_basis text NULL,
  surface_id uuid NOT NULL REFERENCES hr_ticket_surfaces(id),
  origin hr_ticket_origin NOT NULL,
  reporter_name text NULL,
  reporter_contact text NULL,
  reporter_channel hr_reporter_channel NULL,
  reported_at timestamptz NULL,
  reporter_words text NULL,
  task_id uuid NULL REFERENCES hr_tasks(id),
  duplicate_of_ticket_id uuid NULL REFERENCES hr_tickets(id),
  closed_no_task_at timestamptz NULL,
  closed_no_task_by uuid NULL REFERENCES hr_staff(id),
  close_reason text NULL,
  resolution_summary text NULL,
  CONSTRAINT hr_tickets_title_length CHECK (length(trim(title)) >= 10),
  CONSTRAINT hr_tickets_body_length CHECK (length(trim(body)) >= 20),
  CONSTRAINT hr_tickets_severity_basis CHECK (severity <> 'critical' OR length(coalesce(trim(severity_basis), '')) >= 10),
  CONSTRAINT hr_tickets_external_origin CHECK (
    origin <> 'external'
    OR (
      reporter_name IS NOT NULL
      AND reporter_contact IS NOT NULL
      AND reporter_channel IS NOT NULL
      AND reported_at IS NOT NULL
      AND length(coalesce(trim(reporter_words), '')) >= 20
    )
  ),
  CONSTRAINT hr_tickets_duplicate_not_self CHECK (duplicate_of_ticket_id IS DISTINCT FROM id),
  CONSTRAINT hr_tickets_close_reason CHECK (closed_no_task_at IS NULL OR length(coalesce(trim(close_reason), '')) >= 10),
  CONSTRAINT hr_tickets_task_or_close CHECK (task_id IS NULL OR closed_no_task_at IS NULL)
);

CREATE TABLE public.hr_review_weeks (
  week_ending date PRIMARY KEY,
  locked_at timestamptz NULL,
  locked_by uuid NULL REFERENCES hr_staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_review_weeks_friday CHECK (extract(isodow from week_ending) = 5),
  CONSTRAINT hr_review_weeks_lock_pair CHECK ((locked_at IS NULL) = (locked_by IS NULL))
);

ALTER TABLE public.hr_task_attachments
  ADD COLUMN ticket_id uuid NULL REFERENCES hr_tickets(id),
  ALTER COLUMN task_id DROP NOT NULL,
  ADD CONSTRAINT hr_task_attachments_one_parent CHECK (num_nonnulls(task_id, ticket_id) = 1);