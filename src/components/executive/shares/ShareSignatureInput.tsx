import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SignaturePad } from '@/components/shared/SignaturePad';
import { Upload, PenLine, X } from 'lucide-react';

/** Draws a lowercase italic name onto a transparent PNG for use as a typed signature. */
export function typedSignatureDataUrl(fullName: string): string {
  const text = fullName.trim().toLowerCase();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx || !text) return '';
  const font = 'italic 48px "Brush Script MT", "Segoe Script", cursive, serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  canvas.width = Math.max(240, w);
  canvas.height = 90;
  ctx.font = font;
  ctx.fillStyle = '#111827';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 45);
  return canvas.toDataURL('image/png');
}

/** Reads an uploaded image and shrinks it to at most 800px wide so it fits the server size limit. */
async function fileToSignature(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = url;
    });
    const scale = Math.min(1, 800 / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

/** Signature field with two ways in: draw on the pad, or upload a picture of a signature. */
export default function ShareSignatureInput({ value, onChange }: { value?: string; onChange: (d?: string) => void }) {
  const [mode, setMode] = useState<'draw' | 'upload'>('draw');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button type="button" size="sm" variant={mode === 'draw' ? 'default' : 'outline'} onClick={() => { setMode('draw'); onChange(undefined); }}>
          <PenLine className="mr-1 h-3.5 w-3.5" />Draw
        </Button>
        <Button type="button" size="sm" variant={mode === 'upload' ? 'default' : 'outline'} onClick={() => { setMode('upload'); onChange(undefined); }}>
          <Upload className="mr-1 h-3.5 w-3.5" />Upload
        </Button>
      </div>
      {mode === 'draw' ? (
        <SignaturePad onChange={(d: string) => onChange(d || undefined)} />
      ) : (
        <div className="space-y-2">
          <input
            ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              setError(null);
              try { onChange(await fileToSignature(f)); } catch (err: any) { setError(err.message); }
            }}
          />
          {value ? (
            <div className="relative rounded-md border border-border bg-background p-2">
              <img src={value} alt="Uploaded signature" className="mx-auto max-h-24" />
              <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-1 h-6 w-6" onClick={() => onChange(undefined)} aria-label="Remove signature">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />Choose signature image
            </Button>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
