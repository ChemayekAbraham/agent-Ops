/**
 * Push history for the GitHub repository, as recorded by the
 * github-push-webhook edge function into `github_push_events`.
 *
 * Unlike the live commit panel (github-commit-activity), this is a permanent
 * record of who *pushed* what and when: force-pushes, deleted branches and
 * commits later rewritten away all stay visible.
 *
 * Read access is enforced by RLS (cto / ceo / super_admin / manager); anyone
 * else gets an empty list, not an error.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface GithubPushCommit {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  author_login: string | null;
  timestamp: string | null;
  url: string | null;
  distinct: boolean;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GithubPushEvent {
  id: string;
  repoFullName: string;
  branch: string;
  isTag: boolean;
  /** GitHub account that pushed (falls back to the git pusher name). */
  pushedBy: string;
  senderLogin: string | null;
  senderAvatarUrl: string | null;
  pusherEmail: string | null;
  beforeSha: string | null;
  afterSha: string | null;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  compareUrl: string | null;
  commitCount: number;
  distinctCommitCount: number;
  headCommitMessage: string | null;
  commits: GithubPushCommit[];
  filesAdded: number;
  filesRemoved: number;
  filesModified: number;
  receivedAt: string;
}

export interface GithubPushFilters {
  /** Look-back window in days; 0 = all time. Default 30. */
  days?: number;
  /** Only pushes by this GitHub login. */
  senderLogin?: string;
  /** Only pushes to this branch (name without refs/heads/). */
  branch?: string;
  /** Max rows, default 200. */
  limit?: number;
}

export function useGithubPushEvents(filters: GithubPushFilters = {}) {
  const { days = 30, senderLogin, branch, limit = 200 } = filters;

  return useQuery({
    queryKey: ['github-push-events', days, senderLogin ?? null, branch ?? null, limit],
    staleTime: 60_000,
    queryFn: async (): Promise<GithubPushEvent[]> => {
      // Table is newer than the generated types.
      let q = (supabase as any)
        .from('github_push_events')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(limit);
      if (days > 0) q = q.gte('received_at', new Date(Date.now() - days * 86_400_000).toISOString());
      if (senderLogin) q = q.eq('sender_login', senderLogin);
      if (branch) q = q.eq('branch', branch);

      const { data, error } = await q;
      if (error) throw error;

      return (data ?? []).map((r: any): GithubPushEvent => ({
        id: r.id,
        repoFullName: r.repo_full_name,
        branch: r.branch,
        isTag: !!r.is_tag,
        pushedBy: r.sender_login ?? r.pusher_name ?? 'Unknown',
        senderLogin: r.sender_login,
        senderAvatarUrl: r.sender_avatar_url,
        pusherEmail: r.pusher_email,
        beforeSha: r.before_sha,
        afterSha: r.after_sha,
        created: !!r.created,
        deleted: !!r.deleted,
        forced: !!r.forced,
        compareUrl: r.compare_url,
        commitCount: Number(r.commit_count) || 0,
        distinctCommitCount: Number(r.distinct_commit_count) || 0,
        headCommitMessage: r.head_commit_message,
        commits: Array.isArray(r.commits) ? r.commits : [],
        filesAdded: Number(r.files_added) || 0,
        filesRemoved: Number(r.files_removed) || 0,
        filesModified: Number(r.files_modified) || 0,
        receivedAt: r.received_at,
      }));
    },
  });
}
