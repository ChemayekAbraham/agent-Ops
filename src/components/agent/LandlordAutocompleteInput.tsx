import { useEffect, useRef, useState, forwardRef, type Ref, type FocusEvent, type HTMLAttributes } from 'react';
import { Building2, CheckCircle2, Loader2, Phone, ShieldCheck, ShieldAlert, UserPlus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { LandlordOption } from '@/components/agent/LandlordSearchSelect';

interface LandlordAutocompleteInputProps {
  /** Which field this input edits. Both render a search dropdown. */
  field: 'name' | 'phone';
  value: string;
  onChange: (value: string) => void;
  /** Called when the agent taps an existing landlord from the dropdown. */
  onSelect: (landlord: LandlordOption) => void;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  /** Native blur handler (validation, normalisation, etc.). */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  /** Input type — e.g. `tel` for the phone field. */
  type?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  required?: boolean;
  disabled?: boolean;
  id?: string;
  autoFocus?: boolean;
  /**
   * `dropdown` (default) renders the tap-to-use suggestion list.
   * `status` renders no preview list at all — it only checks in the background
   * whether this name/phone already exists and shows a single plain label.
   */
  mode?: 'dropdown' | 'status';
}

/**
 * A landlord name/phone text input that surfaces matching existing landlords
 * as the agent types. Tapping a suggestion fills the whole landlord block
 * (name, phone, property address) via `onSelect` so the agent re-uses the
 * registered landlord instead of re-keying — and a duplicate is never created.
 */
export const LandlordAutocompleteInput = forwardRef<HTMLInputElement, LandlordAutocompleteInputProps>(function LandlordAutocompleteInput(
  {
    field,
    value,
    onChange,
    onSelect,
    placeholder,
    className,
    maxLength,
    onBlur,
    type,
    inputMode,
    required,
    disabled,
    id,
    autoFocus,
    mode = 'dropdown',
  }: LandlordAutocompleteInputProps,
  ref: Ref<HTMLInputElement>
) {
  const [focused, setFocused] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<LandlordOption[]>([]);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce typing
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value.trim()), 400);
    return () => clearTimeout(t);
  }, [value]);

  // Background existence check. In `status` mode it keeps running after blur so
  // the label stays accurate once the agent moves to the next field.
  useEffect(() => {
    if (mode === 'dropdown' && !focused) return;
    const term = debounced;
    // Require at least 3 characters — shorter terms fan out to millions of
    // ILIKE matches and pin the database CPU at 100%.
    if (term.length < 3) {
      setResults([]);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    (async () => {
      setLoading(true);
      try {
        // Route through the trigram-indexed fuzzy RPC (same fast path used by
        // LandlordSearchSelect). This eliminates the multi-second
        // ORDER BY name ILIKE OR ILIKE scans that were pinning DB CPU.
        const { data, error } = await (supabase.rpc as any)('search_landlords_fuzzy', {
          p_query: term,
          p_limit: 8,
          p_threshold: 0.2,
        });
        if (error) throw error;
        if (myId === reqIdRef.current) {
          const rows = (data ?? []) as LandlordOption[];
          // Verified landlords first so the agent reuses a trusted record.
          rows.sort((a, b) => (Boolean(a.verified) === Boolean(b.verified) ? 0 : a.verified ? -1 : 1));
          setResults(rows);
        }
      } catch (err) {
        if (myId === reqIdRef.current) {
          console.warn('[LandlordAutocompleteInput] fetch failed', err);
          setResults([]);
        }
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    })();
  }, [debounced, focused, mode]);

  const showDropdown = mode === 'dropdown' && focused && debounced.length >= 3;
  const showStatus = mode === 'status' && debounced.length >= 3;
  // The "Already on record" label must NEVER fire on a partial/first-name hit —
  // "Nakanwagi Edith" is a different landlord from "Nakanwagi Evelyn". Require an
  // exact full-name match (case- and whitespace-insensitive) for the name field,
  // and an exact digit match for the phone field.
  const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const normDigits = (s: string) => s.replace(/\D/g, '').replace(/^256/, '0');
  const exactMatch = results.find((r) =>
    field === 'name'
      ? normName(r.name ?? '') === normName(debounced)
      : normDigits(r.phone ?? '') === normDigits(debounced)
  );
  const match = mode === 'status' ? exactMatch : results[0];


  return (
    <div className="relative">
      <Input
        ref={ref}
        id={id}
        type={type}
        inputMode={inputMode}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          onBlur?.(e);
          // Delay so a tap on a suggestion registers before we close.
          blurTimer.current = setTimeout(() => setFocused(false), 150);
        }}
        placeholder={placeholder}
        className={className}
        maxLength={maxLength}
        autoComplete="off"
      />
      {showStatus && (
        <div className="mt-1 text-[11px]">
          {loading ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking our records…
            </span>
          ) : match ? (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                onSelect(match);
                setFocused(false);
              }}
              className="flex items-center gap-1 text-left font-medium text-primary"
            >
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              <span className="truncate">
                Already on record: {match.name} • {match.phone}
                {match.verified ? ' (verified)' : ''} — tap to use
              </span>
            </button>
          ) : (
            <span className="flex items-center gap-1 text-muted-foreground">
              <UserPlus className="h-3 w-3 shrink-0" /> No match found — this will be registered as a new landlord.
            </span>
          )}
        </div>
      )}
      {showDropdown && (
        <div className="absolute z-50 mt-1.5 w-full rounded-xl border-2 bg-popover shadow-xl overflow-hidden max-h-72 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              Not found — just keep typing to add a new landlord.
            </div>
          )}
          {!loading &&
            results.map((l) => (
              <button
                key={l.id}
                type="button"
                onMouseDown={(e) => {
                  // onMouseDown beats the input blur so the select still fires.
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  onSelect(l);
                  setFocused(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-3 text-left border-b last:border-b-0 hover:bg-accent active:bg-accent transition-colors"
              >
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
              <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold truncate">{l.name}</p>
                    {l.verified ? (
                      <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                        <ShieldCheck className="h-3 w-3" /> Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                        <ShieldAlert className="h-3 w-3" /> Needs Ops
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                    <Phone className="h-3 w-3 shrink-0" /> {l.phone}
                    {l.property_address ? ` • ${l.property_address}` : ''}
                  </p>
                </div>
                <span className="text-[11px] font-semibold text-primary shrink-0">Tap to use</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
});
