import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cropImageToSquare, loadImageElement } from '@/lib/cropImage';
import { toast } from 'sonner';

const FRAME = 288; // px

interface Props {
  file: File | null;
  onCancel: () => void;
  /** Receives the cropped copy. The original `file` is left untouched. */
  onConfirm: (cropped: File) => void;
}

/**
 * Drag/zoom a face into a round frame. Produces a cropped COPY — the caller
 * keeps the original shot for the verification archive.
 */
export default function SelfieCropDialog({ file, onCancel, onConfirm }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      setNatural(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    loadImageElement(file)
      .then((img) => setNatural({ w: img.naturalWidth, h: img.naturalHeight }))
      .catch(() => setNatural(null));
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // Scale that makes the image cover the square frame at zoom 1.
  const baseScale = natural ? FRAME / Math.min(natural.w, natural.h) : 1;
  const displayW = natural ? natural.w * baseScale * zoom : FRAME;
  const displayH = natural ? natural.h * baseScale * zoom : FRAME;

  const clamp = (o: { x: number; y: number }) => {
    const maxX = Math.max(0, (displayW - FRAME) / 2);
    const maxY = Math.max(0, (displayH - FRAME) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, o.x)),
      y: Math.max(-maxY, Math.min(maxY, o.y)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset(clamp({
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    }));
  };
  const onPointerUp = () => { drag.current = null; };

  const handleConfirm = async () => {
    if (!file || !natural) return;
    setBusy(true);
    try {
      const scale = baseScale * zoom;                 // display px per source px
      const sizeSrc = FRAME / scale;                  // crop side in source px
      const centreX = natural.w / 2 - offset.x / scale;
      const centreY = natural.h / 2 - offset.y / scale;
      const cropped = await cropImageToSquare(file, {
        x: centreX - sizeSrc / 2,
        y: centreY - sizeSrc / 2,
        size: sizeSrc,
      });
      onConfirm(cropped);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not crop that photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust your photo</DialogTitle>
          <DialogDescription>
            Drag your face into the circle and zoom until it fits. Your original photo is kept for
            verification — this crop is only for your profile picture.
          </DialogDescription>
        </DialogHeader>

        <div
          className="relative mx-auto overflow-hidden rounded-full border-4 border-primary/40 bg-muted touch-none"
          style={{ width: FRAME, height: FRAME }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {url && (
            <img
              src={url}
              alt="Your photo being adjusted"
              draggable={false}
              className="absolute select-none"
              style={{
                width: displayW,
                height: displayH,
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              }}
            />
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Zoom</p>
          <Slider
            value={[zoom]}
            min={1}
            max={4}
            step={0.05}
            onValueChange={(v) => { setZoom(v[0]); setOffset((o) => clamp(o)); }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Retake</Button>
          <Button onClick={handleConfirm} disabled={busy || !natural}>
            {busy ? 'Preparing…' : 'Use this photo'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
