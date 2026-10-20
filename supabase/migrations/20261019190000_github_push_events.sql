-- Every push to the GitHub repository, recorded as it happens.
--
-- The CTO dashboard's commit panel (edge function github-commit-activity) reads
-- GitHub live, so it shows who *authored* each commit as GitHub sees it right
-- now. It cannot say who *pushed*, and anything removed by a force-push or a
-- deleted branch disappears without trace. This table is the permanent record:
-- one row per push webhook delivery, written only by the github-push-webhook
-- edge function (service role) after it has verified GitHub's signature.

CREATE TABLE IF NOT EXISTS public.github_push_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- X-GitHub-Delivery: unique per delivery, so a redelivery is a no-op.
  delivery_id          text NOT NULL UNIQUE,
  repo_full_name       text NOT NULL,
  ref                  text NOT NULL,
  -- ref without refs/heads/ or refs/tags/
  branch               text NOT NULL,
  is_tag               boolean NOT NULL DEFAULT false,
  -- Who pushed (git identity on the push) and the GitHub account that sent it.
  pusher_name          text,
  pusher_email         text,
  sender_login         text,
  sender_avatar_url    text,
  before_sha           text,
  after_sha            text,
  created              boolean NOT NULL DEFAULT false,
  deleted              boolean NOT NULL DEFAULT false,
  forced               boolean NOT NULL DEFAULT false,
  compare_url          text,
  commit_count         integer NOT NULL DEFAULT 0,
  -- Commits new to the repository (excludes ones already on another branch).
  distinct_commit_count integer NOT NULL DEFAULT 0,
  head_commit_message  text,
  -- [{sha, message, author_name, author_email, author_login, timestamp, url,
  --   distinct, added[], removed[], modified[]}]  (GitHub sends at most 2048)
  commits              jsonb NOT NULL DEFAULT '[]'::jsonb,
  files_added          integer NOT NULL DEFAULT 0,
  files_removed        integer NOT NULL DEFAULT 0,
  files_modified       integer NOT NULL DEFAULT 0,
  received_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_push_events_received_at_idx
  ON public.github_push_events (received_at DESC);
CREATE INDEX IF NOT EXISTS github_push_events_sender_idx
  ON public.github_push_events (sender_login, received_at DESC);
CREATE INDEX IF NOT EXISTS github_push_events_branch_idx
  ON public.github_push_events (branch, received_at DESC);

ALTER TABLE public.github_push_events ENABLE ROW LEVEL SECURITY;

-- Read: the same roles that can open the commit panel. No insert/update/delete
-- policy exists, so only the service role (the webhook) can write.
DROP POLICY IF EXISTS github_push_events_select_leadership ON public.github_push_events;
CREATE POLICY github_push_events_select_leadership
  ON public.github_push_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role::text IN ('cto', 'ceo', 'super_admin', 'manager')
    )
  );

REVOKE ALL ON public.github_push_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.github_push_events FROM authenticated;
GRANT SELECT ON public.github_push_events TO authenticated;
GRANT ALL ON public.github_push_events TO service_role;

COMMENT ON TABLE public.github_push_events IS
  'One row per GitHub push webhook delivery (who pushed, branch, commits, files). Written only by the github-push-webhook edge function.';
