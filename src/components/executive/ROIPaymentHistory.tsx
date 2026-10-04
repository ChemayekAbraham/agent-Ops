import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, CheckCircle2, Clock, Calendar, Banknote, Users, Zap } from 'lucide-react';
import { format } from 'date-fns';
import { useState } from 'react';

interface ROIPayment {
  id: string;
  supporter_id: string;
  rent_request_id: string;
  rent_amount: number;
  roi_amount: number;
  payment_number: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  created_at: string;
}

interface SupporterProfile {
  id: string;
  full_name: string | null;
  phone: string | null;
}

export function ROIPaymentHistory() {
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: roiPayments, isLoading } = useQuery({
    queryKey: ['ops-roi-payment-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('supporter_roi_payments')
        .select('id, supporter_id, rent_request_id, rent_amount, roi_amount, payment_number, status, due_date, paid_at, created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) throw error;
      return (data || []) as ROIPayment[];
    },
    staleTime: 300000,
  });

  // Fetch supporter names for display
  const supporterIds = [...new Set((roiPayments || []).map(p => p.supporter_id))];

  const { data: supporterProfiles } = useQuery({
    queryKey: ['ops-roi-supporter-profiles', supporterIds.join(',')],
    queryFn: async () => {
      if (supporterIds.length === 0) return {};
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', supporterIds);
      const map: Record<string, SupporterProfile> = {};
      (data || []).forEach((p: any) => { map[p.id] = p; });
      return map;
    },
    enabled: supporterIds.length > 0,
    staleTime: 600000,
  });

  const payments = roiPayments || [];
  const profiles = supporterProfiles || {};

  // KPI calculations
  const totalPaid = payments.filter(p => p.status === 'paid').reduce((s, p) => s + p.roi_amount, 0);
  const totalPayments = payments.filter(p => p.status === 'paid').length;
  const uniqueSupporters = new Set(payments.filter(p => p.status === 'paid').map(p => p.supporter_id)).size;
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const paidToday = payments.filter(p => p.paid_at && p.paid_at.startsWith(todayStr));
  const paidTodayAmount = paidToday.reduce((s, p) => s + p.roi_amount, 0);

  // Filter
  const filtered = statusFilter === 'all' ? payments : payments.filter(p => p.status === statusFilter);

  const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-emerald-500/10">
            <TrendingUp className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-bold text-base">ROI Auto-Payouts</h3>
            <p className="text-xs text-muted-foreground">Automatic 15% monthly rewards paid to supporter wallets</p>
          </div>
        </div>
        <Badge variant="secondary" className="gap-1 text-xs">
          <Zap className="h-3 w-3 text-emerald-500" />
          Auto-pay active
        </Badge>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Banknote className="h-4 w-4 text-emerald-600" />
              <span className="text-xs text-muted-foreground">Total Paid Out</span>
            </div>
            <p className="text-lg font-black text-emerald-600">UGX {fmt(totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span className="text-xs text-muted-foreground">Total Payments</span>
            </div>
            <p className="text-lg font-black">{totalPayments}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-blue-600" />
              <span className="text-xs text-muted-foreground">Supporters Paid</span>
            </div>
            <p className="text-lg font-black text-blue-600">{uniqueSupporters}</p>
          </CardContent>
        </Card>
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Calendar className="h-4 w-4 text-amber-600" />
              <span className="text-xs text-muted-foreground">Paid Today</span>
            </div>
            <p className="text-lg font-black text-amber-600">
              {paidToday.length > 0 ? `${paidToday.length} (UGX ${fmt(paidTodayAmount)})` : '0'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {['all', 'paid', 'pending'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {s === 'all' ? 'All' : s === 'paid' ? '✅ Paid' : '⏳ Pending'}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading ROI payment history...</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No ROI payments found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">Supporter</th>
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">Rent Amount</th>
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">ROI Paid</th>
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">Payment #</th>
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-3 font-semibold text-xs text-muted-foreground">Paid At</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((payment) => {
                    const supporter = profiles[payment.supporter_id];
                    return (
                      <tr key={payment.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div>
                            <p className="font-medium text-sm">{supporter?.full_name || 'Unknown'}</p>
                            <p className="text-xs text-muted-foreground">{supporter?.phone || payment.supporter_id.slice(0, 8)}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-medium">UGX {Number(payment.rent_amount).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <span className="font-bold text-emerald-600">+UGX {Number(payment.roi_amount).toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="text-xs">#{payment.payment_number}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {payment.status === 'paid' ? (
                            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs gap-1">
                              <CheckCircle2 className="h-3 w-3" /> Paid
                            </Badge>
                          ) : (
                            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-xs gap-1">
                              <Clock className="h-3 w-3" /> Pending
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {payment.paid_at ? format(new Date(payment.paid_at), 'dd MMM yyyy, h:mm a') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
