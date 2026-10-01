/**
 * ThirtyMAwarenessFields — inline 30M awareness question group.
 *
 * Rendered INSIDE the "Engaged" tab of RecordOutcomeDialog via the
 * `awareness30mSection` slot. The parent calls `save()` (returned by this
 * hook) after the engaged outcome is successfully recorded.
 *
 * No separate dialog, no second step — the officer fills these in while
 * writing their call notes, then clicks "Record engaged call" once.
 *
 * Calling / hang-up logic is completely unchanged.
 */
import { useState, useImperativeHandle, forwardRef } from 'react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { TrendingUp } from 'lucide-react';
import type {
  AwarenessBefore,
  ExplanationGiven,
  UnderstandingAfter,
  AwarenessInterest,
} from '@/hooks/use30mAwareness';

// ---- option lists -----------------------------------------------------------

const AWARENESS_BEFORE_OPTIONS: { value: AwarenessBefore; label: string }[] = [
  { value: 'knew', label: 'Knew about it' },
  { value: 'heard', label: 'Heard but unsure' },
  { value: 'did_not_know', label: 'Did not know' },
];

const EXPLANATION_OPTIONS: { value: ExplanationGiven; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'partly', label: 'Partly' },
  { value: 'no', label: 'No' },
];

const UNDERSTANDING_OPTIONS: { value: UnderstandingAfter; label: string }[] = [
  { value: 'understood', label: 'Understood' },
  { value: 'partly_understood', label: 'Partly understood' },
  { value: 'did_not_understand', label: 'Did not understand' },
];

const INTEREST_OPTIONS: { value: AwarenessInterest; label: string }[] = [
  { value: 'apply_now', label: 'Wants to apply now' },
  { value: 'interested_later', label: 'Interested later' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'not_sure', label: 'Not sure' },
];

// ---- ref handle (lets the parent read the current values) -------------------

export interface ThirtyMAwarenessFieldsHandle {
  /** Returns the current values, or null if any question is unanswered. */
  getValues(): {
    awarenessBefore: AwarenessBefore;
    explanationGiven: ExplanationGiven;
    understandingAfter: UnderstandingAfter;
    interest: AwarenessInterest;
  } | null;
  reset(): void;
}

// ---- component --------------------------------------------------------------

function RadioOption<T extends string>({
  name,
  value,
  current,
  label,
  onChange,
}: {
  name: string;
  value: T;
  current: T | '';
  label: string;
  onChange: (v: T) => void;
}) {
  const id = `${name}-${value}`;
  return (
    <Label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-emerald-500 has-[[data-state=checked]]:bg-emerald-500/5"
    >
      <RadioGroupItem id={id} value={value} className="h-3.5 w-3.5 shrink-0" />
      {label}
    </Label>
  );
}

export const ThirtyMAwarenessFields = forwardRef<ThirtyMAwarenessFieldsHandle>(
  function ThirtyMAwarenessFields(_props, ref) {
    const [awarenessBefore, setAwarenessBefore] = useState<AwarenessBefore | ''>('');
    const [explanationGiven, setExplanationGiven] = useState<ExplanationGiven | ''>('');
    const [understandingAfter, setUnderstandingAfter] = useState<UnderstandingAfter | ''>('');
    const [interest, setInterest] = useState<AwarenessInterest | ''>('');

    useImperativeHandle(ref, () => ({
      getValues() {
        if (!awarenessBefore || !explanationGiven || !understandingAfter || !interest) return null;
        return { awarenessBefore, explanationGiven, understandingAfter, interest };
      },
      reset() {
        setAwarenessBefore('');
        setExplanationGiven('');
        setUnderstandingAfter('');
        setInterest('');
      },
    }));

    return (
      <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-emerald-500/10 p-1 text-emerald-600">
            <TrendingUp className="h-3 w-3" />
          </div>
          <span className="text-[11px] font-bold text-emerald-700">30M Rent Plan Awareness</span>
          <span className="ml-auto text-[10px] text-muted-foreground">optional</span>
        </div>

        {/* Q1 */}
        <fieldset className="space-y-1">
          <legend className="text-[10px] font-semibold text-muted-foreground">
            1. Before your explanation — what did they know?
          </legend>
          <RadioGroup
            value={awarenessBefore}
            onValueChange={(v) => setAwarenessBefore(v as AwarenessBefore)}
            className="flex flex-wrap gap-1"
          >
            {AWARENESS_BEFORE_OPTIONS.map((o) => (
              <RadioOption
                key={o.value}
                name="awareness-before"
                value={o.value}
                current={awarenessBefore}
                label={o.label}
                onChange={setAwarenessBefore}
              />
            ))}
          </RadioGroup>
        </fieldset>

        {/* Q2 */}
        <fieldset className="space-y-1">
          <legend className="text-[10px] font-semibold text-muted-foreground">
            2. Did you explain the 30M feature?
          </legend>
          <RadioGroup
            value={explanationGiven}
            onValueChange={(v) => setExplanationGiven(v as ExplanationGiven)}
            className="flex flex-wrap gap-1"
          >
            {EXPLANATION_OPTIONS.map((o) => (
              <RadioOption
                key={o.value}
                name="explanation"
                value={o.value}
                current={explanationGiven}
                label={o.label}
                onChange={setExplanationGiven}
              />
            ))}
          </RadioGroup>
        </fieldset>

        {/* Q3 */}
        <fieldset className="space-y-1">
          <legend className="text-[10px] font-semibold text-muted-foreground">
            3. After your explanation — how well did they understand?
          </legend>
          <RadioGroup
            value={understandingAfter}
            onValueChange={(v) => setUnderstandingAfter(v as UnderstandingAfter)}
            className="flex flex-wrap gap-1"
          >
            {UNDERSTANDING_OPTIONS.map((o) => (
              <RadioOption
                key={o.value}
                name="understanding"
                value={o.value}
                current={understandingAfter}
                label={o.label}
                onChange={setUnderstandingAfter}
              />
            ))}
          </RadioGroup>
        </fieldset>

        {/* Q4 */}
        <fieldset className="space-y-1">
          <legend className="text-[10px] font-semibold text-muted-foreground">
            4. Their interest / intent to apply?
          </legend>
          <RadioGroup
            value={interest}
            onValueChange={(v) => setInterest(v as AwarenessInterest)}
            className="flex flex-wrap gap-1"
          >
            {INTEREST_OPTIONS.map((o) => (
              <RadioOption
                key={o.value}
                name="interest"
                value={o.value}
                current={interest}
                label={o.label}
                onChange={setInterest}
              />
            ))}
          </RadioGroup>
        </fieldset>
      </div>
    );
  },
);
