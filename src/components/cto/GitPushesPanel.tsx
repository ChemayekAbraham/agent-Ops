import { useState } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { AlertCircle, ChevronDown, ExternalLink, GitBranch, GitCommit, Upload, RefreshCw } from 'lucide-react';
import { useGithubPushEvents, type GithubPushEvent } from '@/hooks/useGithubPushEvents';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

const ALL = '__all__';

function PushCard({ push }: { push: GithubPushEvent }) {
  const [open, setOpen] = useState(false);
  const received = new Date(push.receivedAt);
  const validDate = Number.isFinite(received.getTime());
  return (
    <article className="min-w-0 rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarImage src={push.senderAvatarUrl ?? undefined} alt={push.pushedBy} />
          <AvatarFallback className="bg-primary/10 text-xs text-primary">{push.pushedBy.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
            <p className="break-words text-sm font-semibold text-foreground">{push.pushedBy}</p>
            <time dateTime={push.receivedAt} title={validDate ? format(received, 'PPpp zzz') : push.receivedAt} className="text-xs text-muted-foreground">{validDate ? formatDistanceToNowStrict(received, { addSuffix: true }) : 'Unknown time'}</time>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><GitBranch className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{push.branch}</span></span>
            {push.forced && <Badge variant="warning" className="tracking-normal">Force-push</Badge>}
            {push.created && <Badge variant="secondary" className="tracking-normal">New branch</Badge>}
            {push.deleted && <Badge variant="destructive" className="tracking-normal">Branch deleted</Badge>}
            {push.isTag && <Badge variant="outline" className="tracking-normal">Tag</Badge>}
          </div>
          <p className="break-words text-sm text-foreground">{push.headCommitMessage || '(no head commit message)'}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="text-muted-foreground">{push.commitCount.toLocaleString()} {push.commitCount === 1 ? 'commit' : 'commits'}</span>
            <span className="inline-flex gap-2 font-mono" aria-label={`${push.filesAdded} files added, ${push.filesModified} modified, ${push.filesRemoved} removed`}><span className="text-success">+{push.filesAdded}</span><span className="text-muted-foreground">~{push.filesModified}</span><span className="text-destructive">−{push.filesRemoved}</span></span>
            {push.compareUrl && <a href={push.compareUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary">View on GitHub <ExternalLink className="h-3 w-3 shrink-0" /></a>}
          </div>
        </div>
      </div>
      <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="gap-2" aria-label={`${open ? 'Hide' : 'Show'} commits for ${push.pushedBy} on ${push.branch}`}><GitCommit className="h-3.5 w-3.5" />{open ? 'Hide commits' : 'Show commits'} ({push.commits.length})<ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} /></Button></CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 divide-y divide-border border-t border-border">
            {push.commits.map((commit, index) => (
              <li key={`${commit.sha}-${index}`} className="space-y-2 py-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                  {commit.url ? <a href={commit.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-primary">{commit.sha.slice(0, 7)}<ExternalLink className="h-3 w-3" /></a> : <span className="font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>}
                  <div className="min-w-0"><p className="break-words text-sm">{commit.message.split('\n')[0] || '(no message)'}</p><p className="text-xs text-muted-foreground">{commit.author_login || commit.author_name || 'Unknown author'}</p></div>
                </div>
                {[{ paths: commit.added, label: 'Added', prefix: '+', color: 'text-success' }, { paths: commit.modified, label: 'Modified', prefix: '~', color: 'text-muted-foreground' }, { paths: commit.removed, label: 'Removed', prefix: '−', color: 'text-destructive' }].map(({ paths, label, prefix, color }) => paths.length > 0 && <div key={label} className="min-w-0"><p className={`text-xs font-medium ${color}`}>{label}</p><ul className="mt-1 space-y-1">{paths.map((path, i) => <li key={`${path}-${i}`} className="flex items-start gap-2 font-mono text-xs"><span className={color}>{prefix}</span><span className="min-w-0 break-all text-muted-foreground">{path}</span></li>)}</ul></div>)}
              </li>
            ))}
          </ul>
          {push.commits.length === 0 && <p className="py-3 text-xs text-muted-foreground">No commit details recorded for this push.</p>}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

export default function GitPushesPanel({ windows }: { windows: readonly { label: string; days: number }[] }) {
  const [days, setDays] = useState(30);
  const [person, setPerson] = useState(ALL);
  const [branch, setBranch] = useState(ALL);
  // Window query preserves all filter choices; identical default queries share a cache/request.
  const windowQuery = useGithubPushEvents({ days });
  const people = [...new Set((windowQuery.data ?? []).map(push => push.pushedBy))].sort();
  const branches = [...new Set((windowQuery.data ?? []).map(push => push.branch))].sort();
  const senderLogin = person === ALL ? undefined : windowQuery.data?.find(push => push.pushedBy === person)?.senderLogin ?? undefined;
  const query = useGithubPushEvents({ days, senderLogin, branch: branch === ALL ? undefined : branch });
  // Fallback Git pusher names have no sender_login to filter in the hook.
  const pushes = (query.data ?? []).filter(push => person === ALL || push.pushedBy === person);
  const error = query.error || windowQuery.error;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground"><Upload className="h-5 w-5 text-primary" />GitHub pushes</h2>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="grid min-w-0 flex-1 grid-cols-4 overflow-hidden rounded-lg border border-border sm:flex">{windows.map(window => <Button key={window.days} variant={days === window.days ? 'default' : 'ghost'} size="sm" className="rounded-none px-2 text-xs sm:px-3" aria-pressed={days === window.days} onClick={() => { setDays(window.days); setPerson(ALL); setBranch(ALL); }}>{window.label}</Button>)}</div>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" aria-label="Refresh pushes" title="Refresh pushes" disabled={query.isFetching || windowQuery.isFetching} onClick={() => { void windowQuery.refetch(); if (person !== ALL || branch !== ALL) void query.refetch(); }}><RefreshCw className={`h-3.5 w-3.5 ${query.isFetching || windowQuery.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} /></Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select value={person} onValueChange={setPerson}><SelectTrigger aria-label="Filter pushes by person" className="h-10 text-sm"><SelectValue placeholder="All people" /></SelectTrigger><SelectContent><SelectItem value={ALL}>All people</SelectItem>{people.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select>
        <Select value={branch} onValueChange={setBranch}><SelectTrigger aria-label="Filter pushes by branch" className="h-10 text-sm"><SelectValue placeholder="All branches" /></SelectTrigger><SelectContent><SelectItem value={ALL}>All branches</SelectItem>{branches.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select>
      </div>
      {error && <div role="alert" className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div className="min-w-0 text-sm"><p className="font-medium text-destructive">Pushes could not be loaded</p><p className="mt-1 break-words text-muted-foreground">{error.message}</p></div></div>}
      {query.isLoading ? <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-40 w-full rounded-lg" />)}</div> : !error && <>
        <dl className="grid grid-cols-3 gap-3 border-y border-border py-3">{[{ label: 'Total pushes', value: pushes.length }, { label: 'People pushing', value: new Set(pushes.map(push => push.pushedBy)).size }, { label: 'Force-pushes', value: pushes.filter(push => push.forced).length }].map(({ label, value }) => <div key={label} className="min-w-0"><dd className="text-xl font-bold text-foreground">{value}</dd><dt className="text-xs text-muted-foreground">{label}</dt></div>)}</dl>
        {query.data?.length === 200 && <p className="text-xs text-muted-foreground">Showing the latest 200 matching pushes; totals reflect loaded records.</p>}
        {pushes.length === 0 ? <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No pushes recorded yet. Pushes are recorded from the moment the GitHub webhook is connected — earlier history is in the Commits view.</p> : <div className="space-y-3">{pushes.map(push => <PushCard key={push.id} push={push} />)}</div>}
      </>}
    </div>
  );
}
