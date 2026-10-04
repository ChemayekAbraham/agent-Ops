import { Hand, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  SWIPE_THRESHOLD_MIN,
  SWIPE_THRESHOLD_MAX,
  SWIPE_THRESHOLD_DEFAULT,
} from '@/hooks/useSwipeSensitivity';

/**
 * Lets the user tune how easily left/right swipes flip dashboard sections.
 * The slider is presented as "sensitivity" (right = more sensitive) but is
 * backed by a pixel threshold, so a higher sensitivity maps to a SMALLER
 * threshold (a shorter swipe is enough).
 */
export function SwipeSensitivityControl({
  threshold,
  onChange,
}: {
  threshold: number;
  onChange: (threshold: number) => void;
}) {
  // sensitivity 0..100 (high = easy). Invert against the threshold range.
  const span = SWIPE_THRESHOLD_MAX - SWIPE_THRESHOLD_MIN;
  const sensitivity = Math.round(((SWIPE_THRESHOLD_MAX - threshold) / span) * 100);
  const setSensitivity = (value: number) =>
    onChange(SWIPE_THRESHOLD_MAX - (value / 100) * span);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          aria-label="Swipe sensitivity settings"
        >
          <Hand className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold">Swipe sensitivity</h4>
            <p className="text-xs text-muted-foreground">
              Adjust how easily left/right swipes change sections.
            </p>
          </div>

          <Slider
            value={[sensitivity]}
            min={0}
            max={100}
            step={5}
            onValueChange={(v) => setSensitivity(v[0])}
            aria-label="Swipe sensitivity"
          />

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Less sensitive</span>
            <span className="tabular-nums">{threshold}px</span>
            <span>More sensitive</span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center text-xs"
            onClick={() => onChange(SWIPE_THRESHOLD_DEFAULT)}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
