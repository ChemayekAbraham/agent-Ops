import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Home, Plus, FileText, CheckCircle2, Clock } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Agent Personal Rent Request panel — Phase 1 placeholder.
 *
 * This is the landing surface for the new "Agent Personal Rent Request"
 * product category in Agent Ops → Products & Services. It exposes the
 * three expected lifecycle buckets (requests, approvals, repayments) and
 * leaves the detailed mutation/ledger wiring for a follow-up phase.
 */
export function AgentPersonalRentRequestPanel() {
  const [activeTab, setActiveTab] = useState('requests');

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">Agent Personal Rent Financing</h2>
              <p className="text-xs text-muted-foreground">
                Personal rent financing requests, approvals & repayment tracking
              </p>
            </div>
            <Button size="sm" className="gap-1.5 w-full sm:w-auto">
              <Plus className="h-4 w-4" />
              New request
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-700">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending requests</p>
              <p className="text-xl font-bold tabular-nums">0</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Approved</p>
              <p className="text-xl font-bold tabular-nums">0</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Repaying</p>
              <p className="text-xl font-bold tabular-nums">0</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="repayments">Repayments</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Personal rent requests</CardTitle>
            </CardHeader>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No personal rent requests yet. Use "New request" to record the first one.
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="approvals">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Approval queue</CardTitle>
            </CardHeader>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Approved requests will appear here once the approval workflow is wired.
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="repayments">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Repayment tracking</CardTitle>
            </CardHeader>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Repayment schedules and collections will be shown here.
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <Home className="h-5 w-5 text-teal-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">Phase 1 — category shell only</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              The hub card and page route are now live. The request form, approval gates,
              ledger postings and repayment tracking will be implemented in the next phase.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
