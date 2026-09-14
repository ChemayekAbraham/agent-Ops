/**
 * Quick crop / confirm step for the verification selfie.
 *
 * Shown right after the camera returns a shot: the person drags to position
 * their face inside a square frame, zooms in or out, then confirms. The
 * confirmed square is what gets sent for verification and what becomes their
 * profile picture.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, RotateCcw, ZoomIn } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { cropImageToSquare, loadImageElement } from '@/lib/cropImage';

const FRAME = 288; // px — square preview frame

export default function SelfieCropDialog({
  file,
  open,
  onCancel,
  onConfirm,
}: {
  file: File | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (cropped: File) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      setNat(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setZoom(1);
    let cancelled = false;
    loadImageElement(objectUrl)
      .then((img) => {
        if (cancelled) return;
        setNat({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch(() => toast.error('Could not read that photo. Take it again.'));
    return () => {
      cancelled = true;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  const baseScale = nat ? FRAME / Math.min(nat.w, nat.h) : 1;
  const scale = baseScale * zoom;
  const dispW = nat ? nat.w * scale : FRAME;
  const dispH = nat ? nat.h * scale : FRAME;

  const clamp = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(FRAME - dispW, o.x)),
    y: Math.min(0, Math.max(FRAME - dispH, o.y)),
  });

  // Re-centre whenever a new photo arrives or the zoom changes size.
  useEffect(() => {
    if (!nat) return;
    setOffset((prev) => {
      const centred = { x: (FRAME - dispW) / 2, y: (FRAME - dispH) / 2 };
      return prev.x === 0 && prev.y === 0 ? centred : clamp(prev);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat, dispW, dispH]);

  useEffect(() => {
    if (!nat) return;
    setOffset({ x: (FRAME - dispW) / 2, y: (FRAME - dispH) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const confirm = async () => {
    if (!file || !nat) return;
    setBusy(true);
    try {
      const size = FRAME / scale;
      const rect = {
        x: Math.max(0, Math.min(nat.w - size, -offset.x / scale)),
        y: Math.max(0, Math.min(nat.h - size, -offset.y / scale)),
        size,
      };
      const cropped = await cropImageToSquare(file, rect);
      onConfirm(cropped);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not adjust that photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Adjust your selfie</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Drag your face into the middle of the square and zoom in if you need to. This is the
          photo Financial Ops will see and the one that becomes your profile picture.
        </p>

        <div
          className="relative mx-auto overflow-hidden rounded-full border-4 border-primary/40 bg-muted touch-none select-none"
          style={{ width: FRAME, height: FRAME }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {url && (
            <img
              src={url}
              alt="Selfie preview"
              draggable={false}
              className="absolute origin-top-left"
              style={{
                width: dispW,
                height: dispH,
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }}
            />
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
          <Slider
            value={[zoom]}
            min={1}
            max={4}
            step={0.05}
            onValueChange={([v]) => setZoom(v)}
            disabled={busy}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="outline" className="h-11" onClick={onCancel} disabled={busy}>
            <RotateCcw className="h-4 w-4 mr-1.5" />
            Retake
          </Button>
          <Button className="h-11 font-bold" onClick={confirm} disabled={busy || !nat}>
            {busy ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-1.5" />
            )}
            Use this photo
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
