import { useEffect, useState } from 'react';
import { Settings, X, RotateCcw, Plus, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DEFAULT_TIMELINE_SHORTCUTS,
  TIMELINE_SHORTCUT_LABELS,
  TimelineShortcutAction,
  TimelineShortcutPrefs,
  formatShortcutKey,
  resetTimelineShortcuts,
  saveTimelineShortcuts,
  useTimelineShortcuts,
} from '@/lib/timelineShortcutPrefs';
import { toast } from 'sonner';

const ACTIONS: TimelineShortcutAction[] = ['jump', 'next', 'prev', 'first', 'last'];

// Small button that opens the shortcut settings dialog.
export function TimelineShortcutSettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Customize keyboard shortcuts"
        className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground text-[10px]"
      >
        <Settings className="h-3 w-3" />
        <span className="hidden sm:inline">Shortcuts</span>
      </button>
      <TimelineShortcutSettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function TimelineShortcutSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const saved = useTimelineShortcuts();
  const [draft, setDraft] = useState<TimelineShortcutPrefs>(saved);
  const [capturingFor, setCapturingFor] = useState<TimelineShortcutAction | null>(null);

  // Re-sync draft whenever the dialog opens or the saved prefs change externally.
  useEffect(() => {
    if (open) setDraft(saved);
  }, [open, saved]);

  // Capture the next physical key press and assign it to the pending action.
  useEffect(() => {
    if (!capturingFor) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingFor(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Ignore lone modifier keypresses.
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      const action = capturingFor;
      setDraft((d) => {
        const existing = d[action] || [];
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (existing.includes(key)) return d;
        // Warn (but still allow) if the key already binds another action.
        const conflict = (Object.keys(d) as TimelineShortcutAction[]).find(
          (a) => a !== action && d[a].includes(key),
        );
        if (conflict) {
          toast.warning(
            `"${formatShortcutKey(key)}" is already bound to "${TIMELINE_SHORTCUT_LABELS[conflict]}" — it will now trigger "${TIMELINE_SHORTCUT_LABELS[action]}" instead.`,
          );
          return {
            ...d,
            [conflict]: d[conflict].filter((k) => k !== key),
            [action]: [...existing, key],
          };
        }
        return { ...d, [action]: [...existing, key] };
      });
      setCapturingFor(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturingFor]);

  const removeKey = (action: TimelineShortcutAction, key: string) => {
    setDraft((d) => {
      const remaining = d[action].filter((k) => k !== key);
      if (remaining.length === 0) {
        toast.error(`"${TIMELINE_SHORTCUT_LABELS[action]}" needs at least one shortcut.`);
        return d;
      }
      return { ...d, [action]: remaining };
    });
  };

  const handleSave = () => {
    saveTimelineShortcuts(draft);
    toast.success('Keyboard shortcuts saved.');
    onOpenChange(false);
  };

  const handleReset = () => {
    const next = resetTimelineShortcuts();
    setDraft(next);
    toast.success('Shortcuts reset to defaults.');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-xs">
            Customize the keys used to navigate flagged rows in the reconciliation timeline. Click
            <span className="mx-1 inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold">
              <Plus className="h-2.5 w-2.5" /> Add
            </span>
            then press any key to bind it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {ACTIONS.map((action) => {
            const isCapturing = capturingFor === action;
            return (
              <div key={action} className="flex items-center justify-between gap-2 py-1.5 border-b border-border last:border-b-0">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    {TIMELINE_SHORTCUT_LABELS[action]}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Default: {DEFAULT_TIMELINE_SHORTCUTS[action].map(formatShortcutKey).join(' or ')}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-wrap justify-end">
                  {draft[action].map((key) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono font-semibold"
                    >
                      {formatShortcutKey(key)}
                      <button
                        type="button"
                        onClick={() => removeKey(action, key)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCapturingFor(isCapturing ? null : action)}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
                      isCapturing
                        ? 'border-primary bg-primary/10 text-primary animate-pulse'
                        : 'border-border bg-background hover:bg-muted text-muted-foreground'
                    }`}
                  >
                    {isCapturing ? (
                      <>Press a key…</>
                    ) : (
                      <>
                        <Plus className="h-2.5 w-2.5" /> Add
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border bg-background hover:bg-muted text-[11px] text-muted-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Reset defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-7 px-2 rounded-md border border-border bg-background hover:bg-muted text-[11px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-[11px] font-semibold"
            >
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}