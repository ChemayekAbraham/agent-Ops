/**
 * ThirtyMAwarenessDialog — UGX 30M Rent Plan awareness tracking.
 *
 * A SEPARATE dialog from RecordOutcomeDialog.
 *
 * This component renders AFTER an answered (engaged) call has been classified
 * by the existing RecordOutcomeDialog. It captures four structured questions
 * about the tenant's awareness of the 30M Rent Plan feature and saves them to
 * tops_30m_awareness via useSave30mAwareness().
 *
 * The existing calling workflow, hang-up, feedback/comments and RecordOutcomeDialog
 * are completely unchanged. This is purely additive.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  useSave30mAwareness,
  type AwarenessBefore,
  type ExplanationGiven,
  type UnderstandingAfter,
  type AwarenessInterest,
} from '@/hooks/use30mAwareness';

// ---- Option lists -----------------------------------------------------------

const AWARENESS_BEFORE_OPTIONS: { value: AwarenessBefore; label: string }[] = [
  { value: 'knew', label: 'Knew about it' },
  { value: 'heard', label: 'Had heard about it but unsure' },
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

// ---- Component --------------------------------------------------------------

export interface ThirtyMAwarenessDialogProps {
  open: boolean;
  /** The tenant's display name, for the dialog title. */
  tenantName: string;
  /** The tenant's profile user id (NOT the cycle row id). */
  tenantUserId: string;
  /** Soft link to the cc_call_attempts row — no FK. */
  ccCallId: string | null;
  /** Tenant's current Rent Plan limit at call time (UGX). May be null. */
  rentPlanLimitUgx: number | null;
  /** Called when the dialog should close (skip or save). */
  onClose: () => void;
}

export function ThirtyMAwarenessDialog({
  open,
  tenantName,
  tenantUserId,
  ccCallId,
  rentPlanLimitUgx,
  onClose,
}: ThirtyMAwarenessDialogProps) {
  const { user } = useAuth();
  const save = useSave30mAwareness();

  const [awarenessBefore, setAwarenessBefore] = useState<AwarenessBefore | ''>('');
  const [explanationGiven, setExplanationGiven] = useState<ExplanationGiven | ''>('');
  const [understandingAfter, setUnderstandingAfter] = useState<UnderstandingAfter | ''>('');
  const [interest, setInterest] = useState<AwarenessInterest | ''>('');

  const reset = () => {
    setAwarenessBefore('');
    setExplanationGiven('');
    setUnderstandingAfter('');
    setInterest('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSkip = () => {
    handleClose();
  };

  const handleSave = () => {
    if (!awarenessBefore) return toast.error('Please answer Q1 — awareness before the call.');
    if (!explanationGiven) return toast.error('Please answer Q2 — was the 30M explained?');
    if (!understandingAfter) return toast.error('Please answer Q3 — understanding after the explanation.');
    if (!interest) return toast.error('Please answer Q4 — tenant interest.');
    if (!user?.id) return toast.error('Could not identify the logged-in officer. Please refresh.');

    save.mutate(
      {
        ccCallId,
        tenantUserId,
        recordedBy: user.id,
        awarenessBefore,
        explanationGiven,
        understandingAfter,
        interest,
        rentPlanLimitUgx,
      },
      {
        onSuccess: () => {
          toast.success('30M awareness saved.');
          handleClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save 30M awareness.'),
      },
    );
  };

  const allAnswered = !!(awarenessBefore && explanationGiven && understandingAfter && interest);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-h-[90svh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <div className="rounded-lg bg-emerald-500/10 p-1.5 text-emerald-600">
              <TrendingUp className="h-3.5 w-3.5" />
            </div>
            30M Awareness — {tenantName}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Record this tenant's awareness of the UGX 30M Rent Plan feature.
            {rentPlanLimitUgx != null && (
              <span className="ml-1">
                Current Rent Plan limit:{' '}
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  UGX {Math.round(rentPlanLimitUgx).toLocaleString()}
                </Badge>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {/* Q1 */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">
              1. Before explanation — what did this tenant know?
            </legend>
            <RadioGroup
              value={awarenessBefore}
              onValueChange={(v) => setAwarenessBefore(v as AwarenessBefore)}
              className="space-y-1"
            >
              {AWARENESS_BEFORE_OPTIONS.map((o) => (
                <Label
                  key={o.value}
                  htmlFor={`awareness-before-${o.value}`}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id={`awareness-before-${o.value}`} value={o.value} className="shrink-0" />
                  {o.label}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          {/* Q2 */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">
              2. Was the 30M Rent Plan explained during this call?
            </legend>
            <RadioGroup
              value={explanationGiven}
              onValueChange={(v) => setExplanationGiven(v as ExplanationGiven)}
              className="space-y-1"
            >
              {EXPLANATION_OPTIONS.map((o) => (
                <Label
                  key={o.value}
                  htmlFor={`explanation-${o.value}`}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id={`explanation-${o.value}`} value={o.value} className="shrink-0" />
                  {o.label}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          {/* Q3 */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">
              3. After explanation — how well did the tenant understand?
            </legend>
            <RadioGroup
              value={understandingAfter}
              onValueChange={(v) => setUnderstandingAfter(v as UnderstandingAfter)}
              className="space-y-1"
            >
              {UNDERSTANDING_OPTIONS.map((o) => (
                <Label
                  key={o.value}
                  htmlFor={`understanding-${o.value}`}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id={`understanding-${o.value}`} value={o.value} className="shrink-0" />
                  {o.label}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          {/* Q4 */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">
              4. Interest / application intent
            </legend>
            <RadioGroup
              value={interest}
              onValueChange={(v) => setInterest(v as AwarenessInterest)}
              className="space-y-1"
            >
              {INTEREST_OPTIONS.map((o) => (
                <Label
                  key={o.value}
                  htmlFor={`interest-${o.value}`}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id={`interest-${o.value}`} value={o.value} className="shrink-0" />
                  {o.label}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={handleSkip}
              disabled={save.isPending}
            >
              Skip
            </Button>
            <Button
              className="flex-1 text-xs"
              onClick={handleSave}
              disabled={!allAnswered || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save 30M awareness'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
