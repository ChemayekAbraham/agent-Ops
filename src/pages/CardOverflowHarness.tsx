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
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-36 pt-2.5">
        <div className="grid gap-0 sm:grid-cols-2 sm:gap-4 [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_420px]">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <FunderNewHouseCard
                category="ready"
                item={mock}
                saved={false}
                selected={false}
                distance={null}
                onSave={() => {}}
                onSelect={() => {}}
                onDetail={() => {}}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
