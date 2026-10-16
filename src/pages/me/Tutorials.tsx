import { useEffect, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { capabilities } from '@/ops-tutorials/api';
import LibraryTab from '@/ops-tutorials/tabs/LibraryTab';
import MyVideosTab from '@/ops-tutorials/tabs/MyVideosTab';

interface Caps { is_staff?: boolean; is_creator?: boolean; is_reviewer?: boolean; is_admin?: boolean }

export default function Tutorials() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<string>('library');

  useEffect(() => {
    let cancelled = false;
    capabilities()
      .then((c: Caps) => { if (cancelled) return; setCaps(c ?? {}); if (c?.is_creator) setTab('mine'); })
      .catch(() => { if (!cancelled) setCaps(null); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  return (
    <PersonalLayout title="Tutorial videos">
      {!loaded ? (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : caps && caps.is_staff === false ? (
        <Card><CardContent className="p-6 text-center text-muted-foreground">Tutorials are for Welile staff.</CardContent></Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="flex w-full flex-wrap h-auto justify-start">
            <TabsTrigger value="library">Library</TabsTrigger>
            {caps?.is_creator && <TabsTrigger value="mine">My videos</TabsTrigger>}
            {/* TUT-10 tab triggers */}
          </TabsList>
          <TabsContent value="library" className="mt-4"><LibraryTab /></TabsContent>
          {caps?.is_creator && <TabsContent value="mine" className="mt-4"><MyVideosTab /></TabsContent>}
          {/* TUT-10 tab contents */}
        </Tabs>
      )}
    </PersonalLayout>
  );
}
