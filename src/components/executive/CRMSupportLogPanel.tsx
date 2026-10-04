import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  MessageSquareWarning, HeartHandshake, Plus, Download, Loader2, CheckCircle2,
  Smile, Meh, Frown, Star, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { generateCrmSupportReportPdf } from '@/lib/crmSupportReportPdf';

const fmtUGX = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

type Experience = 'excellent' | 'good' | 'fair' | 'bad';

const EXPERIENCE_META: Record<Experience, { label: string; icon: typeof Smile; cls: string }> = {
  excellent: { label: 'Excellent', icon: Star, cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
  good: { label: 'Good', icon: Smile, cls: 'bg-blue-500/10 text-blue-600 border-blue-500/30' },
  fair: { label: 'Fair', icon: Meh, cls: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  bad: { label: 'Bad', icon: Frown, cls: 'bg-destructive/10 text-destructive border-destructive/30' },
};

interface IssueRecord {
  id: string;
  customer_name: string;
  contact: string | null;
  issue: string;
  experience: string;
  solution: string | null;
  status: string;
  created_at: string;
}

interface SupportRecord {
  id: string;
  partner_name: string;
  invested_on: string;
  amount: number;
  notes: string | null;
  created_at: string;
}

interface CRMSupportLogPanelProps {
  title: string;
  subtitle: string;
  defaultTab?: 'issues' | 'support';
}

export function CRMSupportLogPanel({ title, subtitle, defaultTab = 'issues' }: CRMSupportLogPanelProps) {
  const qc = useQueryClient();
  const [monthOffset, setMonthOffset] = useState(0);
  const [exporting, setExporting] = useState(false);

  const monthStart = useMemo(() => startOfMonth(subMonths(new Date(), monthOffset)), [monthOffset]);
  const monthEnd = useMemo(() => endOfMonth(monthStart), [monthStart]);
  const monthLabel = format(monthStart, 'MMMM yyyy');
  const rangeKey = monthStart.toISOString();

  // ── Issues query ──
  const { data: issues = [], isLoading: issuesLoading } = useQuery({
    queryKey: ['crm-issues', rangeKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_customer_issues')
        .select('id, customer_name, contact, issue, experience, solution, status, created_at')
        .gte('created_at', monthStart.toISOString())
        .lte('created_at', monthEnd.toISOString())
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as IssueRecord[];
    },
  });

  // ── Support query ──
  const { data: support = [], isLoading: supportLoading } = useQuery({
    queryKey: ['crm-support', rangeKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_tenant_support')
        .select('id, partner_name, invested_on, amount, notes, created_at')
        .gte('invested_on', format(monthStart, 'yyyy-MM-dd'))
        .lte('invested_on', format(monthEnd, 'yyyy-MM-dd'))
        .order('invested_on', { ascending: false });
      if (error) throw error;
      return (data || []) as SupportRecord[];
    },
  });

  const totalInvested = support.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const resolvedCount = issues.filter((i) => i.status === 'resolved').length;

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await generateCrmSupportReportPdf(monthLabel, issues, support);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `customer-support-report-${format(monthStart, 'yyyy-MM')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast.success('Monthly report downloaded');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate report');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonthOffset((m) => m + 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[110px] text-center">{monthLabel}</span>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={monthOffset === 0} onClick={() => setMonthOffset((m) => Math.max(0, m - 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={handleExport} disabled={exporting} className="gap-2">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Monthly PDF
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="Issues Logged" value={String(issues.length)} icon={MessageSquareWarning} cls="bg-primary/10 text-primary" />
        <KpiTile label="Resolved" value={String(resolvedCount)} icon={CheckCircle2} cls="bg-emerald-500/10 text-emerald-600" />
        <KpiTile label="Investments" value={String(support.length)} icon={HeartHandshake} cls="bg-blue-500/10 text-blue-600" />
        <KpiTile label="Total Invested" value={fmtUGX(totalInvested)} icon={Star} cls="bg-purple-500/10 text-purple-600" />
      </div>

      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="issues" className="gap-1.5"><MessageSquareWarning className="h-4 w-4" /> Customer Issues</TabsTrigger>
          <TabsTrigger value="support" className="gap-1.5"><HeartHandshake className="h-4 w-4" /> Tenant Support</TabsTrigger>
        </TabsList>

        {/* ── Customer Issues ── */}
        <TabsContent value="issues" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Complaints & Experience — {monthLabel}</CardTitle>
              <IssueDialog onSaved={() => qc.invalidateQueries({ queryKey: ['crm-issues'] })} />
            </CardHeader>
            <CardContent>
              {issuesLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              ) : issues.length === 0 ? (
                <EmptyState text="No issues logged this month. Click “Log Issue” to add one." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Complaint</TableHead>
                        <TableHead>Experience</TableHead>
                        <TableHead>Solution</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {issues.map((r) => {
                        const exp = EXPERIENCE_META[(r.experience as Experience)] || EXPERIENCE_META.fair;
                        const ExpIcon = exp.icon;
                        return (
                          <TableRow key={r.id}>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{format(new Date(r.created_at), 'dd MMM')}</TableCell>
                            <TableCell>
                              <div className="font-medium text-sm">{r.customer_name}</div>
                              {r.contact && <div className="text-xs text-muted-foreground">{r.contact}</div>}
                            </TableCell>
                            <TableCell className="max-w-[220px] text-sm">{r.issue}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={cn('gap-1', exp.cls)}>
                                <ExpIcon className="h-3 w-3" /> {exp.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[220px] text-sm text-muted-foreground">{r.solution || '—'}</TableCell>
                            <TableCell>
                              <Badge variant={r.status === 'resolved' ? 'default' : 'secondary'}>
                                {r.status === 'resolved' ? 'Resolved' : 'Open'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tenant Support ── */}
        <TabsContent value="support" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Partner Investments — {monthLabel}</CardTitle>
              <SupportDialog onSaved={() => qc.invalidateQueries({ queryKey: ['crm-support'] })} />
            </CardHeader>
            <CardContent>
              {supportLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              ) : support.length === 0 ? (
                <EmptyState text="No investments recorded this month. Click “Record Investment” to add one." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Partner</TableHead>
                        <TableHead>Notes</TableHead>
                        <TableHead className="text-right">Amount Invested</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {support.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{format(new Date(r.invested_on), 'dd MMM yyyy')}</TableCell>
                          <TableCell className="font-medium text-sm">{r.partner_name}</TableCell>
                          <TableCell className="max-w-[280px] text-sm text-muted-foreground">{r.notes || '—'}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{fmtUGX(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={3} className="font-semibold">Total</TableCell>
                        <TableCell className="text-right font-bold tabular-nums">{fmtUGX(totalInvested)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiTile({ label, value, icon: Icon, cls }: { label: string; value: string; icon: typeof Star; cls: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', cls)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

// ── Add Issue dialog ──
function IssueDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [contact, setContact] = useState('');
  const [issue, setIssue] = useState('');
  const [experience, setExperience] = useState<Experience>('fair');
  const [solution, setSolution] = useState('');
  const [status, setStatus] = useState('open');

  const reset = () => {
    setCustomerName(''); setContact(''); setIssue(''); setExperience('fair'); setSolution(''); setStatus('open');
  };

  const save = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('crm_customer_issues').insert({
        customer_name: customerName.trim(),
        contact: contact.trim() || null,
        issue: issue.trim(),
        experience,
        solution: solution.trim() || null,
        status,
        recorded_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Issue logged');
      reset(); setOpen(false); onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to save'),
  });

  const canSave = customerName.trim() && issue.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5"><Plus className="h-4 w-4" /> Log Issue</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Log Customer Issue</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Customer name *</Label>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. Jane Doe" maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone / contact</Label>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Optional" maxLength={60} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Complaint / issue *</Label>
            <Textarea value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Describe the customer's complaint…" rows={3} maxLength={1000} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Experience</Label>
              <Select value={experience} onValueChange={(v) => setExperience(v as Experience)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent</SelectItem>
                  <SelectItem value="good">Good</SelectItem>
                  <SelectItem value="fair">Fair</SelectItem>
                  <SelectItem value="bad">Bad</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Solution</Label>
            <Textarea value={solution} onChange={(e) => setSolution(e.target.value)} placeholder="How was it solved? (optional)" rows={2} maxLength={1000} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add Support dialog ──
function SupportDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [partnerName, setPartnerName] = useState('');
  const [investedOn, setInvestedOn] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const reset = () => { setPartnerName(''); setInvestedOn(format(new Date(), 'yyyy-MM-dd')); setAmount(''); setNotes(''); };

  const save = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('crm_tenant_support').insert({
        partner_name: partnerName.trim(),
        invested_on: investedOn,
        amount: Number(amount) || 0,
        notes: notes.trim() || null,
        recorded_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Investment recorded');
      reset(); setOpen(false); onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to save'),
  });

  const canSave = partnerName.trim() && investedOn && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5"><Plus className="h-4 w-4" /> Record Investment</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Record Partner Investment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Partner name *</Label>
            <Input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} placeholder="e.g. John Partner" maxLength={120} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date invested *</Label>
              <Input type="date" value={investedOn} onChange={(e) => setInvestedOn(e.target.value)} max={format(new Date(), 'yyyy-MM-dd')} />
            </div>
            <div className="space-y-1.5">
              <Label>Amount (UGX) *</Label>
              <Input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" min={0} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" rows={2} maxLength={500} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Investment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}