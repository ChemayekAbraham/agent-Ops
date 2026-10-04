import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Briefcase, RefreshCw, MapPin, Link2, ChevronDown,
  Clock, PhoneCall, Users, CheckCircle2, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { toast } from 'sonner';
import ApplicantCommsLog from './ApplicantCommsLog';

interface JobApplication {
  id: string;
  full_name: string;
  whatsapp_number: string;
  email: string | null;
  category: string;
  role_interest: string | null;
  experience_level: string | null;
  portfolio_url: string | null;
  location: string | null;
  cover_note: string | null;
  status: string;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  developer: 'Developer',
  sales: 'Sales',
  marketing: 'Marketing',
  operations: 'Operations',
  other: 'Other',
};

const CATEGORY_COLORS: Record<string, string> = {
  developer: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30',
  sales: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  marketing: 'bg-pink-500/15 text-pink-700 dark:text-pink-400 border-pink-500/30',
  operations: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  other: 'bg-muted text-muted-foreground border-border',
};

interface StatusMeta {
  value: string;
  label: string;
  icon: typeof Clock;
  badge: string;
  order: number;
}

const STATUSES: StatusMeta[] = [
  { value: 'new', label: 'New', icon: Clock, badge: 'border-warning/40 text-warning', order: 0 },
  { value: 'contacted', label: 'Contacted', icon: PhoneCall, badge: 'border-blue-500/40 text-blue-600 dark:text-blue-400', order: 1 },
  { value: 'interviewing', label: 'Interviewing', icon: Users, badge: 'border-purple-500/40 text-purple-600 dark:text-purple-400', order: 2 },
  { value: 'hired', label: 'Hired', icon: CheckCircle2, badge: 'border-success/40 text-success', order: 3 },
  { value: 'rejected', label: 'Rejected', icon: XCircle, badge: 'border-destructive/40 text-destructive', order: 4 },
];

const statusMeta = (value: string): StatusMeta =>
  STATUSES.find(s => s.value === value) ?? STATUSES[0];

type SortKey = 'newest' | 'oldest' | 'name' | 'status';

export default function JobApplicationsPanel() {
  const [apps, setApps] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('newest');

  const fetchApps = useCallback(async () => {
    setLoading(true);
    const { data, error } = await (supabase.from('job_applications' as any) as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      console.error('Error fetching job applications:', error);
    } else {
      setApps((data || []) as JobApplication[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  const changeStatus = async (id: string, status: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    const patch: Record<string, any> = { status };
    if (status !== 'new') {
      patch.contacted_by = user?.id ?? null;
      patch.contacted_at = new Date().toISOString();
    }
    const { error } = await (supabase.from('job_applications' as any) as any)
      .update(patch)
      .eq('id', id);
    if (error) {
      toast.error('Could not update status', { description: error.message });
      return;
    }
    toast.success(`Marked as ${statusMeta(status).label}`);
    setApps(prev => prev.map(a => a.id === id ? { ...a, status } : a));
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: apps.length };
    for (const s of STATUSES) c[s.value] = 0;
    for (const a of apps) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [apps]);

  const categoriesPresent = useMemo(() => {
    const set = new Set(apps.map(a => a.category));
    return STATUSES.length ? Array.from(set) : [];
  }, [apps]);

  const visible = useMemo(() => {
    let list = apps.slice();
    if (statusFilter !== 'all') list = list.filter(a => a.status === statusFilter);
    if (categoryFilter !== 'all') list = list.filter(a => a.category === categoryFilter);
    list.sort((a, b) => {
      switch (sortKey) {
        case 'oldest': return +new Date(a.created_at) - +new Date(b.created_at);
        case 'name': return a.full_name.localeCompare(b.full_name);
        case 'status': return statusMeta(a.status).order - statusMeta(b.status).order;
        case 'newest':
        default: return +new Date(b.created_at) - +new Date(a.created_at);
      }
    });
    return list;
  }, [apps, statusFilter, categoryFilter, sortKey]);

  const newCount = counts['new'] ?? 0;

  return (
    <div className="mb-6 rounded-2xl border-2 border-primary/30 bg-primary/5 overflow-hidden no-print">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-primary/20 bg-primary/10">
        <div className="w-9 h-9 rounded-xl bg-primary/20 flex items-center justify-center">
          <Briefcase className="h-4.5 w-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-foreground">Job Applications</h2>
            {newCount > 0 && (
              <Badge className="bg-destructive text-destructive-foreground border-0 text-[10px]">
                {newCount} NEW · Priority
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Contact applicants via WhatsApp or email (info@welile.com)</p>
        </div>
        <button onClick={fetchApps} className="p-2 rounded-lg hover:bg-primary/10 transition-colors">
          <RefreshCw className={cn('h-4 w-4 text-muted-foreground', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Status pipeline tabs */}
      <div className="flex flex-wrap gap-1.5 px-3 pt-3">
        <button
          onClick={() => setStatusFilter('all')}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
            statusFilter === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:border-primary/40'
          )}
        >
          All <span className="opacity-70">({counts.all})</span>
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatusFilter(s.value)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium border transition-colors inline-flex items-center gap-1',
              statusFilter === s.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:border-primary/40'
            )}
          >
            <s.icon className="h-3 w-3" />
            {s.label} <span className="opacity-70">({counts[s.value] ?? 0})</span>
          </button>
        ))}
      </div>

      {/* Category + sort controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categoriesPresent.map((c) => (
              <SelectItem key={c} value={c}>{CATEGORY_LABELS[c] || c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="name">Name (A–Z)</SelectItem>
            <SelectItem value="status">Pipeline stage</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">{visible.length} shown</span>
      </div>

      <div className="p-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-8">
            <Briefcase className="h-10 w-10 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground">No applications{statusFilter !== 'all' || categoryFilter !== 'all' ? ' match these filters' : ' yet'}</p>
            <p className="text-xs text-muted-foreground">Applications from /careers will appear here.</p>
          </div>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {visible.map((a) => {
              const sm = statusMeta(a.status);
              return (
                <div key={a.id} className="rounded-xl border border-border bg-card p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{a.full_name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <Badge variant="outline" className={cn('text-[10px]', CATEGORY_COLORS[a.category] || CATEGORY_COLORS.other)}>
                          {CATEGORY_LABELS[a.category] || a.category}
                        </Badge>
                        {a.role_interest && <span className="text-[11px] text-muted-foreground truncate">{a.role_interest}</span>}
                      </div>
                    </div>

                    {/* Status changer */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className={cn('shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors', sm.badge)}>
                          <sm.icon className="h-3 w-3" />
                          {sm.label}
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {STATUSES.map((s) => (
                          <DropdownMenuItem
                            key={s.value}
                            onClick={() => changeStatus(a.id, s.value)}
                            className={cn('gap-2 text-xs', a.status === s.value && 'bg-muted font-semibold')}
                          >
                            <s.icon className="h-3.5 w-3.5" />
                            {s.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {a.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {a.location}</span>}
                    {a.experience_level && <span>Experience: {a.experience_level}</span>}
                    {a.portfolio_url && (
                      <a href={a.portfolio_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline truncate">
                        <Link2 className="h-3 w-3 shrink-0" /> {a.portfolio_url}
                      </a>
                    )}
                    {a.cover_note && <p className="text-[11px] leading-snug line-clamp-3 text-foreground/80">{a.cover_note}</p>}
                    <span className="text-[10px]">Applied {format(new Date(a.created_at), 'dd MMM yyyy, HH:mm')}</span>
                  </div>

                  <ApplicantCommsLog
                    applicationId={a.id}
                    whatsappNumber={a.whatsapp_number}
                    email={a.email}
                    applicantName={a.full_name}
                    roleInterest={a.role_interest}
                    onFirstContact={() => { if (a.status === 'new') changeStatus(a.id, 'contacted'); }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
