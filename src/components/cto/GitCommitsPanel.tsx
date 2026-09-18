import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { GitCommit, ExternalLink, RefreshCw, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

interface CommitRow {
  sha: string;
  short_sha: string;
  message: string;
  author_login: string | null;
  author_name: string;
  avatar_url: string | null;
  profile_url: string | null;
  date: string | null;
  html_url: string;
}

interface Contributor {
  key: string;
  name: string;
  login: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  commits: number;
  last_commit_at: string | null;
}

interface ActivityResponse {
  repo: string;
  repo_url: string;
  days: number;
  branches_scanned?: number;
  total_commits: number;
  truncated: boolean;
  page: number;
  per_page: number;
  total_pages: number;
  contributors: Contributor[];
  commits: CommitRow[];
}

const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: 0 },
];

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

export default function GitCommitsPanel() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);

  const { data, isLoading, error, refetch, isFetching } = useQuery<ActivityResponse>({
    queryKey: ['cto-git-commits', days, page],
    staleTime: 120_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data: res, error: err } = await supabase.functions.invoke('github-commit-activity', {
        body: { days, page },
      });
      if (err) {
        let detail = err.message;
        const ctx = (err as { context?: { text?: () => Promise<string> } }).context;
        if (ctx?.text) {
          try {
            const raw = await ctx.text();
            const parsed = JSON.parse(raw);
            detail = parsed.message || parsed.details || parsed.error || raw;
          } catch {
            /* keep original message */
          }
        }
        throw new Error(detail);
      }
      return res as ActivityResponse;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <GitCommit className="h-5 w-5 text-primary" /> Code commits
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data?.repo ?? 'weliletenants-sys/welilereceipts-com-98bba33b'} — everyone who committed, across all
            {data?.branches_scanned ? ` ${data.branches_scanned}` : ''} branches
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border overflow-hidden">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => { setDays(w.days); setPage(1); }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  days === w.days ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 flex gap-3">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Commits could not be loaded</p>
            <p className="text-muted-foreground mt-1 break-words">{(error as Error).message}</p>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-xl font-bold">{data.total_commits.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Commits{data.truncated ? ' (partial)' : ''}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-xl font-bold">{data.contributors.length}</p>
              <p className="text-xs text-muted-foreground">People committing</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 col-span-2">
              <p className="text-xs text-muted-foreground mb-1">Repository</p>
              <a
                href={data.repo_url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-primary inline-flex items-center gap-1 break-all"
              >
                {data.repo} <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
            <h3 className="text-sm font-semibold mb-3">Commits per person</h3>
            <div className="flex flex-wrap gap-2">
              {data.contributors.map((c) => (
                <a
                  key={c.key}
                  href={c.profile_url ?? data.repo_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-2.5 py-1.5 hover:bg-muted transition-colors"
                >
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt={c.name} className="h-7 w-7 rounded-full object-cover" loading="lazy" />
                  ) : (
                    <span className="h-7 w-7 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center">
                      {initials(c.name)}
                    </span>
                  )}
                  <span className="text-xs">
                    <span className="font-medium text-foreground">{c.login ?? c.name}</span>
                    <span className="text-muted-foreground">
                      {' '}· {c.commits === 0 ? 'none in this period' : c.commits}
                    </span>
                  </span>
                </a>
              ))}
              {data.contributors.length === 0 && (
                <p className="text-xs text-muted-foreground">No commits in this period.</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
            {data.commits.map((c) => (
              <div key={c.sha} className="flex items-start gap-3 p-3">
                {c.avatar_url ? (
                  <img src={c.avatar_url} alt={c.author_name} className="h-8 w-8 rounded-full object-cover shrink-0" loading="lazy" />
                ) : (
                  <span className="h-8 w-8 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center shrink-0">
                    {initials(c.author_name)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground break-words">{c.message || '(no message)'}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {c.author_login ?? c.author_name}
                    {c.date ? ` · ${format(new Date(c.date), 'dd MMM yyyy HH:mm')}` : ''}
                  </p>
                </div>
                <a
                  href={c.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono text-primary inline-flex items-center gap-1 shrink-0"
                >
                  {c.short_sha} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
            {data.commits.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No commits in this period.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
