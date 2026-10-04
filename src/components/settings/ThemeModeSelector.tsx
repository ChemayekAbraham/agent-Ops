import { Moon, Sun, MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { hapticSelection } from '@/lib/haptics';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun, hint: 'Bright background' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Easy on the eyes' },
  { value: 'system', label: 'System', icon: MonitorSmartphone, hint: 'Match device' },
] as const;

/**
 * Explicit Light / Dark / System selector for Settings → Look.
 * Preference is persisted device-locally by next-themes (localStorage `theme`).
 */
export function ThemeModeSelector() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = mounted ? (theme ?? 'light') : 'light';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const selected = active === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setTheme(opt.value);
                hapticSelection();
              }}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-colors touch-manipulation',
                selected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/50 bg-card text-muted-foreground hover:bg-muted/50',
              )}
            >
              <Icon className={cn('h-5 w-5', selected ? 'text-primary' : 'text-muted-foreground')} />
              <span className="text-xs font-semibold">{opt.label}</span>
              <span className="text-[10px] leading-tight text-muted-foreground">{opt.hint}</span>
            </button>
          );
        })}
      </div>
      {mounted && (
        <p className="text-[11px] text-muted-foreground">
          Currently showing <span className="font-medium text-foreground">{resolvedTheme === 'dark' ? 'dark' : 'light'}</span> mode.
        </p>
      )}
    </div>
  );
}

export default ThemeModeSelector;