import { useState, useRef, type ChangeEvent } from 'react';
import { FileUp, FileText, X, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  SPECIAL_ADVANCE_PROOF_TYPES,
  SPECIAL_ADVANCE_PROOF_MAX_BYTES,
  describeSpecialAdvanceError,
} from '@/lib/specialAdvances';
import { getSpecialAdvanceProofUrl } from '@/hooks/useSpecialAdvances';

interface SpecialAdvanceProofInputProps {
  id?: string;
  label?: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
  required?: boolean;
  description?: string;
}

export function SpecialAdvanceProofInput({
  id = 'special-advance-proof-file',
  label = 'Proof file (receipt or statement)',
  file,
  onFileChange,
  disabled = false,
  required = true,
  description = 'JPEG, PNG, WebP image or PDF up to 10 MB.',
}: SpecialAdvanceProofInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    if (!SPECIAL_ADVANCE_PROOF_TYPES.includes(selected.type)) {
      setLocalError('The proof must be a JPEG, PNG or WebP image, or a PDF.');
      onFileChange(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    if (selected.size <= 0 || selected.size > SPECIAL_ADVANCE_PROOF_MAX_BYTES) {
      setLocalError('The proof file must be between 1 byte and 10 MB.');
      onFileChange(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setLocalError(null);
    onFileChange(selected);
  };

  const handleRemove = () => {
    onFileChange(null);
    setLocalError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs font-medium">
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        {description && <span className="text-[10px] text-muted-foreground">{description}</span>}
      </div>

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={SPECIAL_ADVANCE_PROOF_TYPES.join(',')}
        className="hidden"
        disabled={disabled}
        onChange={handleSelect}
      />

      {!file ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full h-14 border-dashed justify-center gap-2 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp className="h-4 w-4" />
          <span>Select receipt or statement</span>
        </Button>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/80 bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{file.name}</p>
              <p className="text-[10px] text-muted-foreground">{formatSize(file.size)}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            disabled={disabled}
            onClick={handleRemove}
            aria-label="Remove proof file"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {localError && <p role="alert" className="text-[11px] text-destructive">{localError}</p>}
    </div>
  );
}

/**
 * Click-to-view button that requests a fresh 60-second signed URL for an archived proof file.
 * Never prefetches; handles missing storage policies gracefully.
 */
export function SpecialAdvanceProofLink({
  path,
  label = 'View proof',
  className = '',
}: {
  path?: string | null;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  if (!path) return null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await getSpecialAdvanceProofUrl(path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const msg = (err as Error)?.message || '';
      if (/permission|policy|row-level/i.test(msg)) {
        toast.error('Proof files are not available yet');
      } else {
        toast.error(describeSpecialAdvanceError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-6 px-1.5 text-xs text-primary hover:text-primary/80 gap-1 ${className}`}
      disabled={busy}
      onClick={() => void handleClick()}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
      <span>{label}</span>
    </Button>
  );
}
