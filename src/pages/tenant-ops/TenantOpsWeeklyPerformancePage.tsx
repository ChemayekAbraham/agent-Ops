import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CalendarX2, TrendingUp } from 'lucide-react';
import { WeeklyPerformanceTab } from '@/components/executive/tenant-ops/workspace/WeeklyPerformanceTab';
import NoPaymentTab from '@/components/executive/tenant-ops/workspace/NoPaymentTab';

const TAB_TRIGGER_CLASS =
  'h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm';

export default function TenantOpsWeeklyPerformancePage() {
  return (
    <Card className="min-w-0 border-border/60">
      <CardHeader className="px-3 pb-3 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-primary" />
          Tenant Ops Weekly Performance
        </CardTitle>
        <CardDescription>
          Portfolio growth, payment behaviour and collection-slowdown risk, reported Wednesday to
          Tuesday and compared week over week.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 px-3 sm:px-6">
        <Tabs defaultValue="weekly">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
            <TabsTrigger value="weekly" className={TAB_TRIGGER_CLASS}>
              <TrendingUp className="mr-1.5 h-3.5 w-3.5" />
              Weekly Performance
            </TabsTrigger>
            <TabsTrigger value="no_payment" className={TAB_TRIGGER_CLASS}>
              <CalendarX2 className="mr-1.5 h-3.5 w-3.5" />
              20+ Days No Payment
            </TabsTrigger>
          </TabsList>
          <TabsContent value="weekly" className="mt-3">
            <WeeklyPerformanceTab />
          </TabsContent>
          <TabsContent value="no_payment" className="mt-3">
            <NoPaymentTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
