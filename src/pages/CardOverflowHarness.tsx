import { motion } from 'framer-motion';
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
      <div className="relative h-[clamp(440px,66svh,620px)] w-full bg-muted" />
      <motion.section
        aria-label="Houses to fund"
        className="relative z-10 -mt-8 rounded-t-[30px] bg-background shadow-[0_-10px_30px_hsl(222_47%_11%/0.12)]"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mx-auto max-w-3xl space-y-4 px-4 pb-36 pt-2.5">
          <div className="grid gap-0 sm:grid-cols-2 sm:gap-4 [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_420px]">
            {[0, 1, 2].map((index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '0px 0px -40px 0px' }}
                transition={{ duration: 0.4, delay: (index % 2) * 0.06, ease: [0.22, 1, 0.36, 1] }}
              >
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
              </motion.div>
            ))}
          </div>
        </div>
      </motion.section>
    </div>
  );
}
