import { useState, useRef, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  describeSpecialAdvanceError,
  newIdempotencyKey,
  type SpecialAdvanceStatement,
} from '@/lib/specialAdvances';
import {
  uploadSpecialAdvanceProof,
  useRecordSpecialAdvanceRecovery,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceProofInput } from './SpecialAdvanceProofInput';

export function SpecialAdvanceRecoveryForm({
  advance,
  onSuccess,
}: {
  advance: SpecialAdvanceStatement;
  onSuccess?: () => void;
}) {
  const recordRecovery = useRecordSpecialAdvanceRecovery();
  const key = useRef(newIdempotencyKey());

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(kampalaTodayYmd());
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When inputs change, generate a new idempotency key
  useEffect(() => {
    key.current = newIdempotencyKey();
  }, [amount, date, method, reference]);

  const handleFileChange = (newFile: File | null) => {
    setFile(newFile);
    setUploadedPath(null);
    key.current = newIdempotencyKey();
  };

  const val = Number(amount) || 0;
  const ready = val > 0 && !!date && reference.trim().length >= 3 && (!!file || !!uploadedPath) && !submitting;

  const executeRecovery = async (proofPathToUse: string) => {
    await recordRecovery.mutateAsync({
      advanceId: advance.id,
      recovery: {
        amount: val,
        received_date: date,
        method,
        reference: reference.trim(),
        note: note.trim() || null,
        idempotency_key: key.current,
        proof_path: proofPathToUse,
      },
    });

    toast.success(`Recovery of ${formatUGX(val)} recorded`);
    setAmount('');
    setReference('');
    setNote('');
    setFile(null);
    setUploadedPath(null);
    onSuccess?.();
  };

  const handleSubmit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setError(null);

    let path = uploadedPath;
    try {
      if (!path && file) {
        path = await uploadSpecialAdvanceProof(advance.id, file);
        setUploadedPath(path);
      }
      if (!path) throw new Error('Proof file is required');

      await executeRecovery(path);
    } catch (err) {
      setError(describeSpecialAdvanceError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3 text-xs">
      <div>
        <h4 className="font-semibold text-foreground">Record recovery</h4>
        <p className="text-muted-foreground text-[11px]">
          Record funds recovered on this written-off advance. Posts to Dr A1 (Cash) / Cr X4 (Credit Losses).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <Label htmlFor="recovery-amount">Amount (UGX) <span className="text-destructive">*</span></Label>
          <Input
            id="recovery-amount"
            inputMode="numeric"
            value={amount ? Number(amount).toLocaleString() : ''}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
            disabled={submitting}
          />
        </div>

        <div>
          <Label htmlFor="recovery-date">Date received <span className="text-destructive">*</span></Label>
          <Input
            id="recovery-date"
            type="date"
            max={kampalaTodayYmd()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div>
          <Label htmlFor="recovery-method">Received by <span className="text-destructive">*</span></Label>
          <Select value={method} onValueChange={(v) => setMethod(v as typeof method)} disabled={submitting}>
            <SelectTrigger id="recovery-method"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mobile_money">Mobile money</SelectItem>
              <SelectItem value="bank_transfer">Bank transfer</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="recovery-reference">Transaction reference <span className="text-destructive">*</span></Label>
          <Input
            id="recovery-reference"
            maxLength={100}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={submitting}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="recovery-note">Note (optional)</Label>
        <Textarea
          id="recovery-note"
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
        />
      </div>

      <SpecialAdvanceProofInput
        id="recovery-proof"
        label="Archived proof of recovery"
        file={file}
        onFileChange={handleFileChange}
        disabled={submitting}
        required
      />

      {error && <p role="alert" className="text-destructive">{error}</p>}

      <Button
        id="recovery-submit"
        size="sm"
        disabled={!ready || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Record recovery
      </Button>
    </div>
  );
}

export default SpecialAdvanceRecoveryForm;
