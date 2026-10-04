import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useVerificationHistory, type VerificationHistoryFile } from '@/hooks/useIdentityPhotos';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, Maximize2, Minimize2, ShieldCheck } from 'lucide-react';

/** One photo opened in the full-resolution viewer. */
interface ViewerPhoto {
  url: string;
  label: string;
  takenAt: string;
  fileName: string;
}

function when(iso: string | null) {
  if (!iso) return 'Date not recorded';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Thumb({
  file,
  label,
  caption,
  round,
  onOpen,
}: {
  file: VerificationHistoryFile | null;
  label: string;
  caption: string;
  round?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex-1 min-w-[130px] space-y-2">
      <p className="text-xs font-medium">{label}</p>
      {file?.url ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full"
          aria-label={`Open ${label} in full resolution`}
        >
          <img
            src={file.url}
            alt={label}
            loading="lazy"
            className={`h-32 w-full border bg-muted object-cover ${round ? 'rounded-full' : 'rounded-lg'}`}
          />
        </button>
      ) : (
        <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground">
          <ImageOff className="h-5 w-5" />
          <span className="text-[11px]">Not saved</span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{caption}</p>
      {file?.url && <p className="text-[11px] text-primary">Tap to view full size</p>}
    </div>
  );
}


export default function VerificationHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile } = useProfile();
  const [params] = useSearchParams();
  const viewUserId = params.get('userId') || user?.id || null;
  const isSelf = !params.get('userId') || params.get('userId') === user?.id;

  const history = useVerificationHistory(viewUserId);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [actualSize, setActualSize] = useState(false);
  // Remembers the fit/full choice per photo (keyed by file name) so switching
  // thumbnails restores however each image was last viewed.
  const resolutionMemory = useRef(new Map<string, boolean>());
  const touchStart = useRef<{ x: number; y: number } | null>(null);


  const entries = useMemo(() => history.data ?? [], [history.data]);

  // Flat list of every viewable photo, in the order the thumbnails appear,
  // so the keyboard can move between them without clicking.
  const flatPhotos = useMemo<ViewerPhoto[]>(() => {
    const list: ViewerPhoto[] = [];
    for (const e of entries) {
      const takenAt = when(e.submittedAt);
      const push = (file: VerificationHistoryFile | null, label: string) => {
        if (!file?.url) return;
        list.push({
          url: file.url,
          label,
          takenAt,
          fileName: file.path.split('/').pop() || 'verification-photo.jpg',
        });
      };
      push(e.original, 'Selfie sent for verification');
      push(e.cropped, 'Cropped profile picture');
      push(e.nationalId, 'National ID photo');
    }
    return list;
  }, [entries]);

  // Maps "<entryId>:<kind>" to that photo's index in flatPhotos.
  const photoIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const e of entries) {
      for (const [kind, file] of [
        ['original', e.original],
        ['cropped', e.cropped],
        ['nationalId', e.nationalId],
      ] as const) {
        if (file?.url) map.set(`${e.id}:${kind}`, i++);
      }
    }
    return map;
  }, [entries]);

  const preview = previewIndex !== null ? flatPhotos[previewIndex] ?? null : null;

  // Toggling resolution records the choice against the photo being viewed.
  const toggleActualSize = () => {
    setActualSize((v) => {
      const next = !v;
      const p = previewIndex !== null ? flatPhotos[previewIndex] : null;
      if (p) resolutionMemory.current.set(p.fileName, next);
      return next;
    });
  };
  // Moving to a photo restores its last-used resolution (default: fit).
  const restoreResolution = (index: number) => {
    const p = flatPhotos[index];
    setActualSize(p ? (resolutionMemory.current.get(p.fileName) ?? false) : false);
  };

  const openPhoto = (index: number) => {
    setPreviewIndex(index);
    restoreResolution(index);
  };
  const stepPhoto = (delta: number) => {
    setPreviewIndex((cur) => {
      if (cur === null || flatPhotos.length === 0) return cur;
      const next = (cur + delta + flatPhotos.length) % flatPhotos.length;
      restoreResolution(next);
      return next;
    });
  };

  // Keyboard controls: ←/→ move between thumbnails, F toggles resolution,
  // O opens in a new tab, D downloads, Escape closes (handled by the dialog).
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (ev: KeyboardEvent) => {
      switch (ev.key) {
        case 'ArrowLeft':
          ev.preventDefault();
          stepPhoto(-1);
          break;
        case 'ArrowRight':
          ev.preventDefault();
          stepPhoto(1);
          break;
        case 'f':
        case 'F':
          ev.preventDefault();
          toggleActualSize();
          break;
        case 'o':
        case 'O': {
          ev.preventDefault();
          const url = flatPhotos[previewIndex]?.url;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          break;
        }
        case 'd':
        case 'D': {
          ev.preventDefault();
          const p = flatPhotos[previewIndex];
          if (p) {
            const a = document.createElement('a');
            a.href = p.url;
            a.download = p.fileName;
            a.click();
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex, flatPhotos]);

  // Preload the neighbouring photos while one is open so swiping or stepping
  // to the next/previous thumbnail renders instantly from cache.
  useEffect(() => {
    if (previewIndex === null || flatPhotos.length < 2) return;
    const neighbors = [previewIndex - 1, previewIndex + 1]
      .map((i) => (i + flatPhotos.length) % flatPhotos.length)
      .map((i) => flatPhotos[i]?.url)
      .filter((u): u is string => !!u);
    const warmers = neighbors.map((url) => {
      const img = new Image();
      img.src = url;
      return img;
    });
    return () => {
      warmers.forEach((img) => {
        img.src = '';
      });
    };
  }, [previewIndex, flatPhotos]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(-1)}>
        <ChevronLeft className="mr-1 h-4 w-4" />
        Back
      </Button>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Verification history
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Every photo you sent for verification is kept here with the date it was sent. The full
            photo is what Financial Ops checks; the round one is the picture you cropped and now use
            as your profile picture.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {isSelf && profile?.avatar_url && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
              <img
                src={profile.avatar_url}
                alt="Current profile picture"
                className="h-14 w-14 rounded-full border object-cover"
              />
              <div>
                <p className="text-sm font-medium">Profile picture in use now</p>
                <p className="text-xs text-muted-foreground">Shown to everyone across the app</p>
              </div>
            </div>
          )}

          {history.isLoading ? (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-48 w-full" />
              ))}
            </div>
          ) : history.error ? (
            <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
              Could not load the verification photos.
            </p>
          ) : entries.length === 0 ? (
            <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground">
              No verification photos yet. They appear here once you send your National ID photo and
              selfie.
            </p>
          ) : (
            entries.map((e, i) => (
              <div key={e.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{when(e.submittedAt)}</p>
                  {i === 0 && <Badge variant="secondary">Latest</Badge>}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Thumb
                    file={e.original}
                    label="Selfie sent for verification"
                    caption="Full, uncropped photo kept for Financial Ops"
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:original`) ?? 0)}
                  />
                  <Thumb
                    file={e.cropped}
                    label="Cropped profile picture"
                    caption="The version you confirmed as your profile picture"
                    round
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:cropped`) ?? 0)}
                  />
                  <Thumb
                    file={e.nationalId}
                    label="National ID photo"
                    caption="Photo of the ID card sent with this selfie"
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:nationalId`) ?? 0)}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreviewIndex(null)}>
        <DialogContent className="max-w-3xl p-3">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-base">{preview?.label}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {preview?.takenAt}
              {previewIndex !== null && flatPhotos.length > 1 && (
                <span className="ml-2">
                  · Photo {previewIndex + 1} of {flatPhotos.length}
                </span>
              )}
            </p>
          </DialogHeader>

          {preview && (
            <div
              className={`max-h-[70vh] w-full rounded-lg bg-muted/40 ${actualSize ? 'overflow-auto' : 'overflow-hidden'}`}
              onTouchStart={(e) => {
                const t = e.touches[0];
                touchStart.current = { x: t.clientX, y: t.clientY };
              }}
              onTouchEnd={(e) => {
                const start = touchStart.current;
                touchStart.current = null;
                // While zoomed to full resolution the photo itself scrolls —
                // swiping there pans the image, it must not change photos.
                if (!start || actualSize || flatPhotos.length < 2) return;
                const t = e.changedTouches[0];
                const dx = t.clientX - start.x;
                const dy = t.clientY - start.y;
                if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                  stepPhoto(dx < 0 ? 1 : -1);
                }
              }}
            >
              <img
                src={preview.url}
                alt={`${preview.label}${previewIndex !== null && flatPhotos.length > 1 ? ` — photo ${previewIndex + 1} of ${flatPhotos.length}` : ''}`}
                className={actualSize ? 'max-w-none' : 'max-h-[70vh] w-full object-contain'}
              />
            </div>
          )}

          {/* Screen-reader status: announces position and resolution mode on every change. */}
          {preview && previewIndex !== null && (
            <p className="sr-only" aria-live="polite" role="status">
              Photo {previewIndex + 1} of {flatPhotos.length}: {preview.label},{' '}
              {actualSize ? 'shown at full resolution' : 'fitted to screen'}.
            </p>
          )}

          <div role="group" aria-label="Photo viewer controls" className="space-y-2">
            {flatPhotos.length > 1 && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stepPhoto(-1)}
                  aria-label={`Previous photo (Left arrow). Currently photo ${(previewIndex ?? 0) + 1} of ${flatPhotos.length}`}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stepPhoto(1)}
                  aria-label={`Next photo (Right arrow). Currently photo ${(previewIndex ?? 0) + 1} of ${flatPhotos.length}`}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => toggleActualSize()}
                aria-pressed={actualSize}
                aria-label={
                  actualSize
                    ? 'Switch to fit-to-screen view (F key)'
                    : 'Switch to full resolution (F key)'
                }
              >
                {actualSize ? (
                  <Minimize2 className="mr-2 h-4 w-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {actualSize ? 'Fit to screen' : 'Full resolution'}
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={preview?.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open this photo in a new tab (O key)"
                >
                  <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                  Open in new tab
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={preview?.url}
                  download={preview?.fileName}
                  aria-label="Download this photo (D key)"
                >
                  <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                  Download
                </a>
              </Button>
            </div>
          </div>

          <p className="text-center text-[11px] text-muted-foreground" aria-hidden="true">
            Keyboard: <kbd className="rounded border px-1">←</kbd> <kbd className="rounded border px-1">→</kbd> move
            between photos · <kbd className="rounded border px-1">F</kbd> fit/full resolution ·{' '}
            <kbd className="rounded border px-1">O</kbd> open in new tab · <kbd className="rounded border px-1">D</kbd>{' '}
            download · <kbd className="rounded border px-1">Esc</kbd> close
          </p>
          <p className="sr-only">
            Keyboard shortcuts: left and right arrow keys move between photos, F switches between
            fit-to-screen and full resolution, O opens the photo in a new tab, D downloads it, and
            Escape closes the viewer.
          </p>
        </DialogContent>
      </Dialog>

    </div>
  );
}
