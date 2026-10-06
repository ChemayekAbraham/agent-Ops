/**
 * Dev-only harness: the real `ItemSwipePicker` inside a Dialog that uses the
 * same sizing classes as `SendMoneyDialog` (full-screen on phones, `sm:max-w-md`
 * centred on desktop). No wallet, auth or network.
 *
 * Mounted at `/__e2e/item-swipe-picker` ONLY when `import.meta.env.DEV` is true.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ItemSwipePicker } from '@/components/wallet/ItemSwipePicker';

const ITEMS = [
  { label: 'Welile Rent', hint: 'Rent payment' },
  { label: 'Welile Gift', hint: 'Gift' },
  { label: 'Welile Bread', hint: 'Bread' },
  { label: 'Welile Chapati', hint: 'Chapati' },
  { label: 'Welile Eggs', hint: 'Eggs' },
  { label: 'Welile Fuel', hint: 'Fuel' },
  { label: 'Welile Reward', hint: 'A reward' },
  { label: 'Welile Boda fees', hint: 'Boda ride' },
  { label: 'Welile tax', hint: 'Tax' },
] as const;

export default function ItemSwipePickerHarness() {
  const [open, setOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string>('');

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <p data-testid="picked">{picked}</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-screen max-w-[100vw] overflow-x-hidden px-4 h-[100dvh] max-h-[100dvh] rounded-none border-border/50 glass-card sm:w-full sm:max-w-md sm:h-auto sm:max-h-[85vh] sm:rounded-xl overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>Send Money</DialogTitle>
            <DialogDescription>Pick a person, type an amount, send.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Button type="button" data-testid="open-picker" onClick={() => setPickerOpen(true)}>
              What are you sending?
            </Button>
          </div>
          <ItemSwipePicker
            open={pickerOpen}
            items={ITEMS}
            startLabel={picked || undefined}
            onClose={() => setPickerOpen(false)}
            onPick={(label) => { setPicked(label); setPickerOpen(false); }}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}
