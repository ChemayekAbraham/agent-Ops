import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Inbox, Layers, Search } from 'lucide-react';
import { InboxBucketList } from '@/components/ops/InboxBucketList';
import { SegmentBrowser } from '@/components/ops/SegmentBrowser';
import { TenantOpsSearch } from '@/components/ops/TenantOpsSearch';
import { BehaviorDrawer } from '@/components/ops/BehaviorDrawer';
import { supabase } from '@/integrations/supabase/client';

export function TenantOpsDashboardV2() {
  const [opsUserId, setOpsUserId] = useState<string | null>(null);
  const [behaviorTenantId, setBehaviorTenantId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setOpsUserId(data.user?.id ?? null));
  }, []);

  return (
    <div className="space-y-4">
      <Tabs defaultValue="inbox" className="w-full">
        <TabsList className="grid grid-cols-3 w-full max-w-md">
          <TabsTrigger value="inbox" className="gap-2"><Inbox className="h-4 w-4" />Inbox</TabsTrigger>
          <TabsTrigger value="segments" className="gap-2"><Layers className="h-4 w-4" />Segments</TabsTrigger>
          <TabsTrigger value="search" className="gap-2"><Search className="h-4 w-4" />Search</TabsTrigger>
        </TabsList>

        <TabsContent value="inbox" className="mt-4">
          <InboxBucketList opsUserId={opsUserId} onOpenBehavior={setBehaviorTenantId} />
        </TabsContent>
        <TabsContent value="segments" className="mt-4">
          <SegmentBrowser onOpenBehavior={setBehaviorTenantId} />
        </TabsContent>
        <TabsContent value="search" className="mt-4">
          <TenantOpsSearch onOpenBehavior={setBehaviorTenantId} />
        </TabsContent>
      </Tabs>

      <BehaviorDrawer
        tenantId={behaviorTenantId}
        onOpenChange={(open) => { if (!open) setBehaviorTenantId(null); }}
      />
    </div>
  );
}
