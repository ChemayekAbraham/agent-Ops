import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Plus, TrendingUp, AlertTriangle, DollarSign, Shield, Percent, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { formatUGX, getRiskLevel } from '@/lib/agentAdvanceCalculations';
import IssueAdvanceSheet from '@/components/manager/IssueAdvanceSheet';
import { differenceInDays } from 'date-fns';

export default function AgentAdvances() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'overdue'>('all');
  const [issueOpen, setIssueOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: advances = [], isLoading, refetch } = useQuery({
    queryKey: ['agent-advances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('*, profiles!agent_advances_agent_id_fkey(full_name, phone)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return advances.filter((a: any) => {
      if (filter !== 'all' && a.status !== filter) return false;
      if (!q) return true;
      const name = String(a.profiles?.full_name || '').toLowerCase();
      const phone = String(a.profiles?.phone || '').toLowerCase();
      const status = String(a.status || '').toLowerCase();
      const id = String(a.id || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || status.includes(q) || id.startsWith(q);
    });
  }, [advances, filter, search]);

  const totalIssued = advances.reduce((s: number, a: any) => s + Number(a.principal), 0);
  const totalOutstanding = advances.filter((a: any) => a.status !== 'completed').reduce((s: number, a: any) => s + Number(a.outstanding_balance), 0);
  const totalAccruedInterest = advances.reduce((s: number, a: any) => s + Math.max(0, Number(a.outstanding_balance) - Number(a.principal)), 0);
  const overdueExposure = advances.filter((a: any) => a.status === 'overdue').reduce((s: number, a: any) => s + Number(a.outstanding_balance), 0);
  const riskPct = totalIssued > 0 ? Math.round((totalOutstanding / totalIssued) * 100) : 0;

  const summaryCards = [
    { label: 'Total Advances Issued', value: formatUGX(totalIssued), icon: DollarSign, color: 'text-blue-600' },
    { label: 'Outstanding Balance', value: formatUGX(totalOutstanding), icon: TrendingUp, color: 'text-amber-600' },
    { label: 'Accrued Interest', value: formatUGX(totalAccruedInterest), icon: Percent, color: 'text-purple-600' },
    { label: 'Overdue Exposure', value: formatUGX(overdueExposure), icon: AlertTriangle, color: 'text-red-600' },
    { label: 'Wallet Risk %', value: `${riskPct}%`, icon: Shield, color: riskPct > 80 ? 'text-red-600' : riskPct > 50 ? 'text-amber-600' : 'text-green-600' },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/cfo-dashboard')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Agent Advance Control</h1>
            <p className="text-xs text-muted-foreground">33% monthly compound · Variable periods</p>
          </div>
          <Button onClick={() => setIssueOpen(true)} size="sm" className="gap-1">
            <Plus className="h-4 w-4" /> Issue Advance
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {summaryCards.map((card) => (
            <Card key={card.label} className="border-border/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <card.icon className={`h-4 w-4 ${card.color}`} />
                  <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">{card.label}</span>
                </div>
                <p className="text-lg sm:text-xl font-black tracking-tight">{card.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
          <TabsList>
            <TabsTrigger value="all">All ({advances.length})</TabsTrigger>
            <TabsTrigger value="active">Active ({advances.filter((a: any) => a.status === 'active').length})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({advances.filter((a: any) => a.status === 'completed').length})</TabsTrigger>
            <TabsTrigger value="overdue">Overdue ({advances.filter((a: any) => a.status === 'overdue').length})</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search advances by agent name, phone or status…"
            className="pl-9 pr-9"
            autoComplete="off"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {search && (
          <p className="text-xs text-muted-foreground -mt-2">
            {filtered.length} of {advances.length} advances match “{search}”
          </p>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading advances...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {search ? `No advances match “${search}”` : 'No advances found'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground text-xs uppercase tracking-wider">
                  <th className="pb-3 pr-4">Agent</th>
                  <th className="pb-3 pr-4">Principal</th>
                  <th className="pb-3 pr-4 hidden sm:table-cell">Interest</th>
                  <th className="pb-3 pr-4">Total Payable</th>
                  <th className="pb-3 pr-4 hidden md:table-cell">Daily Deduction</th>
                  <th className="pb-3 pr-4 hidden lg:table-cell">Issue Date</th>
                  <th className="pb-3 pr-4">Days Left</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Risk</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((adv: any) => {
                  const risk = getRiskLevel(adv);
                  const daysLeft = Math.max(0, differenceInDays(new Date(adv.expires_at), new Date()));
                  const interest = Math.max(0, Number(adv.outstanding_balance) - Number(adv.principal));
                  const dailyDeduction = daysLeft > 0 ? Math.round(Number(adv.outstanding_balance) / daysLeft) : Number(adv.outstanding_balance);

                  return (
                    <tr
                      key={adv.id}
                      onClick={() => navigate(`/agent-advances/${adv.id}`)}
                      className="border-b border-border/50 hover:bg-muted/50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 pr-4 font-medium">{adv.profiles?.full_name || 'Unknown'}</td>
                      <td className="py-3 pr-4">{formatUGX(adv.principal)}</td>
                      <td className="py-3 pr-4 hidden sm:table-cell text-amber-600">{formatUGX(interest)}</td>
                      <td className="py-3 pr-4 font-semibold">{formatUGX(adv.outstanding_balance)}</td>
                      <td className="py-3 pr-4 hidden md:table-cell">{formatUGX(dailyDeduction)}</td>
                      <td className="py-3 pr-4 hidden lg:table-cell text-muted-foreground">
                        {new Date(adv.issued_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 pr-4">{daysLeft}d</td>
                      <td className="py-3 pr-4">
                        <Badge variant={adv.status === 'active' ? 'default' : adv.status === 'completed' ? 'secondary' : 'destructive'}>
                          {adv.status}
                        </Badge>
                      </td>
                      <td className="py-3">
                        <div className={`h-3 w-3 rounded-full ${risk === 'green' ? 'bg-green-500' : risk === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <IssueAdvanceSheet open={issueOpen} onOpenChange={setIssueOpen} onSuccess={refetch} />
    </div>
  );
}
