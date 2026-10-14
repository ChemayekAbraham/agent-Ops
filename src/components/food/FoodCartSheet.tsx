import { Info, Loader2, ShoppingBag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  formatUgx, FOOD_PAYMENT_MODE_LABEL, type FoodMenuMeal, type FoodPaymentMode,
} from '@/hooks/useFoodService';

export interface CartLine {
  meal: FoodMenuMeal;
  quantity: number;
}

interface FoodCartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: CartLine[];
  periodName: string | null;
  collectionInstructions: string | null;
  specialInstructions: string;
  onSpecialInstructionsChange: (value: string) => void;
  onChangeQuantity: (menuItemId: string, quantity: number) => void;
  /** server-sent list of accepted modes */
  paymentModes: readonly FoodPaymentMode[];
  /** the employee's choice; null until they pick one — never defaulted */
  paymentMode: FoodPaymentMode | null;
  onPaymentModeChange: (mode: FoodPaymentMode) => void;
  /** server-sent bound on special instructions */
  maxInstructions: number;
  /** server-evaluated; the window can close while the sheet is open */
  orderingOpen: boolean;
  onSubmit: () => void;
  submitting: boolean;
}

export default function FoodCartSheet({
  open, onOpenChange, lines, periodName, collectionInstructions,
  specialInstructions, onSpecialInstructionsChange, onChangeQuantity,
  paymentModes, paymentMode, onPaymentModeChange, maxInstructions, orderingOpen,
  onSubmit, submitting,
}: FoodCartSheetProps) {
  const total = lines.reduce((t, l) => t + l.meal.price_ugx * l.quantity, 0);
  const empty = lines.length === 0;
  const unavailable = lines.some((l) => l.meal.sold_out);
  const canSubmit = !empty && !submitting && !!paymentMode && orderingOpen && !unavailable;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/70 p-4 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
            Your order{periodName ? ` — ${periodName}` : ''}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <ShoppingBag className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm font-medium">Nothing added yet</p>
              <p className="text-xs text-muted-foreground">
                Pick something from today&rsquo;s menu.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ meal, quantity }) => (
                <li key={meal.menu_item_id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{meal.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {quantity} &times; {formatUgx(meal.price_ugx)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums">
                      {formatUgx(meal.price_ugx * quantity)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${meal.name}`}
                      onClick={() => onChangeQuantity(meal.menu_item_id, 0)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!empty && (
            <div className="mt-5 space-y-2">
              <label htmlFor="food-notes" className="text-xs font-medium text-muted-foreground">
                Anything the kitchen should know? (optional)
              </label>
              <Textarea
                id="food-notes"
                value={specialInstructions}
                maxLength={maxInstructions}
                rows={3}
                placeholder="No chilli, please"
                onChange={(e) => onSpecialInstructionsChange(e.target.value)}
              />
            </div>
          )}

          {/*
            Payment mode: required, never pre-selected. It is recorded on the
            order only — nothing is charged now. (Functional markup; styling is
            Gemini's to refine.)
          */}
          {!empty && (
            <fieldset className="mt-5 space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">
                How will you pay after delivery?
              </legend>
              <RadioGroup
                value={paymentMode ?? ''}
                onValueChange={(v) => onPaymentModeChange(v as FoodPaymentMode)}
                className="gap-2"
              >
                {paymentModes.map((m) => (
                  <label key={m} htmlFor={`food-pay-${m}`} className="flex items-center gap-2 text-sm">
                    <RadioGroupItem id={`food-pay-${m}`} value={m} />
                    {FOOD_PAYMENT_MODE_LABEL[m]}
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          )}

          {!empty && collectionInstructions && (
            <p className="mt-4 rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
              {collectionInstructions}
            </p>
          )}
        </div>

        <div className="border-t border-border/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="text-base font-semibold">{formatUgx(total)}</span>
          </div>

          {/*
            Payment is not open. The button says "Place order", never "Pay", and
            the notice below is not dismissible — an employee must not be left
            thinking they have settled anything.
          */}
          <div className="mb-3 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
              Nothing is charged now. Your order is recorded as{' '}
              <strong className="font-semibold">unpaid</strong> with the payment method you
              chose, and you pay after your food is delivered.
            </p>
          </div>

          {!empty && !orderingOpen && (
            <p className="mb-2 text-center text-xs text-destructive">
              Ordering for this service period has closed.
            </p>
          )}

          <Button
            className="w-full"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Place order
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
