import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import type { FunderNewEmptyHouse } from '@/components/funder-new/types';

const mock = {
  house_id: 'h1',
  title: 'Double Room',
  location: 'Katabi Town Council, KAWAFU, Katabi Town Council, Wakiso, Central',
  monthly_rent: 300000,
  lat: 0.1,
  lng: 32.5,
  photos: [],
} as unknown as FunderNewEmptyHouse;

export default function CardOverflowHarness() {
  return (
    <div className="min-h-screen bg-background font-['Outfit'] text-foreground">
      {/* MAP HERO — sticky so the sheet slides over it */}
      <div className="sticky top-0 h-[clamp(440px,66svh,620px)] w-full">
        <div className="relative h-full w-full overflow-hidden bg-emerald-100">
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">MAP</div>
        </div>

        {/* Top bar: avatar / search / GPS — stays above the sheet */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-3xl px-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="pointer-events-auto flex items-center gap-2.5">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-primary text-[15px] font-bold text-primary-foreground shadow-lg">PL</div>
            <div className="flex h-12 min-w-0 flex-1 items-center rounded-full bg-card px-4 text-muted-foreground shadow-lg">Where should we look?</div>
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-card text-primary shadow-lg">◎</div>
          </div>
        </div>

        {/* Amount card — covered by the sheet on scroll */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto max-w-3xl px-4 pt-[calc(max(1rem,env(safe-area-inset-top))+3.75rem)]">
          <div className="pointer-events-auto rounded-3xl bg-primary px-5 py-5 text-primary-foreground shadow-lg">
            <p className="text-[15px] font-semibold">Amount needed to fund houses:</p>
            <p className="mt-2 text-[42px] font-bold leading-none">UGX 400.21M</p>
          </div>
        </div>
      </div>

      {/* HOUSES SHEET */}
      <section className="relative z-10 -mt-8 rounded-t-[30px] bg-background shadow-[0_-10px_30px_hsl(222_47%_11%/0.12)]">
        <div className="mx-auto max-w-3xl space-y-4 px-4 pb-36 pt-2.5">
          <div aria-hidden className="mx-auto h-1.5 w-11 rounded-full bg-border" />
          <h1 className="text-xl font-bold tracking-tight">998 houses in this view</h1>
          <div className="grid gap-0 sm:grid-cols-2 sm:gap-4">
            {Array.from({ length: 12 }).map((_, index) => (
              <FunderNewHouseCard
                key={index}
                category="ready"
                item={mock}
                saved={false}
                selected={false}
                distance={null}
                onSave={() => {}}
                onSelect={() => {}}
                onDetail={() => {}}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
