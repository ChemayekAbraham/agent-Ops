import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export const EVIDENCE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

const VIDEO_MAX = 52428800;
const IMAGE_MAX = 10485760;
const MAX_FILES = 5;

const sizeMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface TicketEvidenceProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export default function TicketEvidence({ files, onChange, disabled }: TicketEvidenceProps) {
  const [problems, setProblems] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewsRef = useRef<Map<File, string>>(new Map());
  const [, setPreviewTick] = useState(0);

  useEffect(() => {
    return () => {
      previewsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewsRef.current.clear();
    };
  }, []);

  const previewFor = (file: File) => {
    if (!file.type.startsWith('image/')) return null;
    let url = previewsRef.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      previewsRef.current.set(file, url);
    }
    return url;
  };

  const handlePick = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const rejected: string[] = [];
    const accepted: File[] = [];

    Array.from(picked).forEach((file) => {
      if (!EVIDENCE_TYPES.includes(file.type)) {
        rejected.push(`${file.name} is not a picture or video we can accept.`);
        return;
      }
      if (file.type.startsWith('video/')) {
        if (file.size > VIDEO_MAX) {
          rejected.push(`${file.name} is larger than 50 MB.`);
          return;
        }
      } else if (file.size > IMAGE_MAX) {
        rejected.push(`${file.name} is larger than 10 MB.`);
        return;
      }
      accepted.push(file);
    });

    let next = [...files];
    accepted.forEach((file) => {
      if (next.length >= MAX_FILES) {
        rejected.push(`You can attach up to ${MAX_FILES} files. ${file.name} was left out.`);
        return;
      }
      next = [...next, file];
    });

    setProblems(rejected);
    onChange(next);
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (file: File) => {
    const url = previewsRef.current.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      previewsRef.current.delete(file);
    }
    setPreviewTick((t) => t + 1);
    onChange(files.filter((f) => f !== file));
  };

  return (
    <div>
      <Label htmlFor="ticket-evidence">Add pictures or a video</Label>
      <input
        id="ticket-evidence"
        ref={inputRef}
        type="file"
        multiple
        disabled={disabled}
        accept={EVIDENCE_TYPES.join(',')}
        onChange={(e) => handlePick(e.target.files)}
        className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm"
      />
      <p className="mt-1 text-xs text-muted-foreground">Kept for 90 days, then deleted.</p>

      {problems.length > 0 && (
        <ul className="mt-2 space-y-1">
          {problems.map((p) => (
            <li key={p} className="text-xs text-destructive">
              {p}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="mt-2 space-y-2">
          {files.map((file) => {
            const preview = previewFor(file);
            return (
              <li
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="flex items-center gap-3 rounded-md border border-border p-2"
              >
                {preview ? (
                  <img
                    src={preview}
                    alt={file.name}
                    className="h-10 w-10 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                    Video
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{sizeMb(file.size)}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => remove(file)}
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}