import { useEffect, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { capabilities, type TutorialCapabilities } from '@/ops-tutorials/api';
import LibraryTab from '@/ops-tutorials/tabs/LibraryTab';
import MyVideosTab from '@/ops-tutorials/tabs/MyVideosTab';
import ReviewTab from '@/ops-tutorials/tabs/ReviewTab';
import PeopleTab from '@/ops-tutorials/tabs/PeopleTab';
import RatesTab from '@/ops-tutorials/tabs/RatesTab';

type Caps = Partial<TutorialCapabilities>;

export default function Tutorials() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<string>('library');

  useEffect(() => {
    let cancelled = false;
    capabilities()
      .then((c: Caps) => {
        if (cancelled) return;
        const v = c ?? {};
        setCaps(v);
        const first = v.is_creator ? 'mine' : v.is_reviewer ? 'review' : v.has_access ? 'library' : v.is_admin ? 'people' : v.can_set_rates ? 'rates' : 'library';
        setTab(first);
      })
      .catch(() => { if (!cancelled) { setFailed(true); setCaps(null); setTab('library'); } })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const c: Caps = failed ? {} : caps ?? {};
  const hasAccess = !failed && c.has_access === true;
  const show = {
    mine: !failed && !!c.is_creator,
    review: !failed && !!c.is_reviewer,
    library: hasAccess,
    people: !failed && !!c.is_admin,
    rates: !failed && !!c.can_set_rates,
  };
  const chips = [
    hasAccess && !c.is_creator && !c.is_reviewer && !c.is_admin && 'Viewer',
    c.is_creator && 'Creator',
    c.is_reviewer && 'Reviewer',
    c.is_admin && 'HR',
    c.can_set_rates && 'Sets rates',
  ].filter(Boolean) as string[];

  return (
    <PersonalLayout title="Tutorial videos">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">Operations how-to videos. Creators upload, reviewers check, management sets the pay.</p>
        {!failed && chips.map((label) => (
          <span key={label} className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium">{label}</span>
        ))}
      </div>
      {!loaded ? (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !hasAccess ? (
        <Card><CardContent className="p-6 text-center text-muted-foreground">You don't have access to Tutorial videos. HR adds people who work on tutorials.</CardContent></Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="flex w-full flex-wrap h-auto justify-start">
            {show.mine && <TabsTrigger value="mine">My work</TabsTrigger>}
            {show.review && <TabsTrigger value="review">Review</TabsTrigger>}
            {show.library && <TabsTrigger value="library">Library</TabsTrigger>}
            {show.people && <TabsTrigger value="people">People</TabsTrigger>}
            {show.rates && <TabsTrigger value="rates">Rates</TabsTrigger>}
          </TabsList>
          {show.mine && <TabsContent value="mine" className="mt-4"><MyVideosTab /></TabsContent>}
          {show.review && <TabsContent value="review" className="mt-4"><ReviewTab /></TabsContent>}
          {show.library && (
            <TabsContent value="library" className="mt-4">
              <LibraryTab />
            </TabsContent>
          )}
          {show.people && <TabsContent value="people" className="mt-4"><PeopleTab canSetRates={!!c.can_set_rates} onChangeRates={() => setTab('rates')} /></TabsContent>}
          {show.rates && <TabsContent value="rates" className="mt-4"><RatesTab /></TabsContent>}
        </Tabs>
      )}
    </PersonalLayout>
  );
}
