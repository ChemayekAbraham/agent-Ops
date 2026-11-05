import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ClipboardCheck, FileText, History, RefreshCw, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RecentApprovalsByCategory } from './RecentApprovalsByCategory';
import { GeneralPayoutActivities } from './GeneralPayoutActivities';

export default function CfoGeneralPayoutActivityPage() {
  const [activeTab, setActiveTab] = useState<'approvals' | 'statements'>('approvals');
  const qc = useQueryClient();

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['cfo-recent-approvals-by-category'] });
    qc.invalidateQueries({ queryKey: ['general-payout-activities'] });
    toast.success('Payout activities refreshed');
  };

  return (
    <div className="space-y-6">
      {/* Executive Command Header */}
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 text-primary shadow-sm ring-1 ring-primary/25">
              <ClipboardCheck className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">General Payout Activity</h1>
                <Badge variant="outline" className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border-primary/20">
                  CFO Audit Desk
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-medium px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-emerald-500" />
                  Live Ledger Movements
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Independent oversight and authoritative log of all platform payout disbursements, approvals, and wallet movements.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted"
              onClick={handleRefresh}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs Layout */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="space-y-5">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-3 flex-wrap">
          <TabsList className="h-10 rounded-xl bg-muted/60 p-1 border border-border/60">
            <TabsTrigger
              value="approvals"
              className="rounded-lg text-xs font-semibold data-[state=active]:bg-background data-[state=active]:shadow-xs gap-2 px-3.5"
            >
              <History className="h-3.5 w-3.5" />
              All Approvals &amp; Activity
            </TabsTrigger>
            <TabsTrigger
              value="statements"
              className="rounded-lg text-xs font-semibold data-[state=active]:bg-background data-[state=active]:shadow-xs gap-2 px-3.5"
            >
              <FileText className="h-3.5 w-3.5" />
              Period Statements &amp; PDF Export
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="approvals" className="space-y-4 focus-visible:outline-none">
          <RecentApprovalsByCategory showCardWrapper={false} />
        </TabsContent>

        <TabsContent value="statements" className="space-y-4 focus-visible:outline-none">
          <GeneralPayoutActivities />
        </TabsContent>
      </Tabs>
    </div>
  );
}
