import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle2, XCircle, ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

type CatalogItem = {
  id: string;
  item_name: string;
  unit_price: number;
  image_url: string | null;
  image_urls: string[] | null;
};

type Tags = Record<string, string>;

type CheckResult = {
  url: string;
  status: number;
  tags: Tags;
  imageOk: boolean | null;
  html: string;
};

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

function parseTags(html: string): Tags {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tags: Tags = {};
  doc.querySelectorAll('meta[property], meta[name]').forEach((el) => {
    const key = el.getAttribute('property') || el.getAttribute('name');
    const value = el.getAttribute('content');
    if (key && value) tags[key.toLowerCase()] = value;
  });
  const title = doc.querySelector('title')?.textContent;
  if (title) tags['title'] = title;
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (canonical) tags['canonical'] = canonical;
  return tags;
}

function imageLoads(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
    setTimeout(() => resolve(false), 8000);
  });
}

export default function MerchandiseSharePreviewCheck() {
  const [selectedId, setSelectedId] = useState<string>('');
  const [manualUrl, setManualUrl] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: catalog = [] } = useQuery<CatalogItem[]>({
    queryKey: ['share-preview-catalog'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('merchandise_catalog')
        .select('id, item_name, unit_price, image_url, image_urls')
        .eq('is_active', true)
        .order('item_name');
      if (error) throw error;
      return (data || []) as CatalogItem[];
    },
  });

  const selected = catalog.find((c) => c.id === selectedId) || null;

  const shareUrl = manualUrl.trim()
    ? manualUrl.trim()
    : selectedId
      ? `${FUNCTIONS_BASE}/og-merchandise?id=${selectedId}&src=preview-check`
      : '';

  const runCheck = async () => {
    if (!shareUrl) {
      toast.error('Pick an item or paste a share link');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const verifyUrl = shareUrl.includes('verify=1')
        ? shareUrl
        : `${shareUrl}${shareUrl.includes('?') ? '&' : '?'}verify=1`;
      const res = await fetch(verifyUrl, { redirect: 'follow' });
      const html = await res.text();
      const tags = parseTags(html);
      const image = tags['og:image'];
      const imageOk = image ? await imageLoads(image) : null;
      setResult({ url: shareUrl, status: res.status, tags, imageOk, html });
    } catch (e: any) {
      setError(e?.message || 'Could not fetch the preview');
    } finally {
      setRunning(false);
    }
  };

  const tags = result?.tags || {};
  const ogImage = tags['og:image'];
  const ogTitle = tags['og:title'] || tags['title'];
  const ogDesc = tags['og:description'] || tags['description'];
  const ogUrl = tags['og:url'];
  let previewHost = '';
  try {
    previewHost = ogUrl ? new URL(ogUrl).host : '';
  } catch { previewHost = ''; }

  const expectedImage = selected
    ? (selected.image_urls?.[0] || selected.image_url || null)
    : null;

  const checks = result
    ? [
        { label: 'Preview page reachable', pass: result.status === 200 },
        { label: 'og:title present', pass: !!ogTitle },
        { label: 'og:description present', pass: !!ogDesc },
        { label: 'og:image present', pass: !!ogImage },
        { label: 'og:image actually loads', pass: result.imageOk === true },
        {
          label: 'og:image is the item photo (not the Welile logo)',
          pass: !!ogImage && !/og-image|welile-logo/i.test(ogImage) &&
            (!expectedImage || ogImage === expectedImage),
        },
        {
          label: 'og:url points at welileapp.com/merchandise',
          pass: !!ogUrl && /welileapp\.com\/merchandise/i.test(ogUrl),
        },
        {
          label: 'Canonical matches og:url',
          pass: !!tags['canonical'] && tags['canonical'] === ogUrl,
        },
      ]
    : [];

  const allPass = checks.length > 0 && checks.every((c) => c.pass);

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-bold">Share preview verification</h1>
        <p className="text-sm text-muted-foreground">
          Confirm that a pasted merchandise link unfurls with the item photo and the branded
          welileapp.com destination before you send it on WhatsApp.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">1. Choose what to verify</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Merchandise item</label>
            <select
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setManualUrl(''); }}
            >
              <option value="">Select an item…</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.item_name} — {formatUGX(Number(c.unit_price))}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">…or paste any share link</label>
            <Input
              placeholder="https://…/functions/v1/og-merchandise?id=…"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
            />
          </div>
          {shareUrl && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-xs">
              <span className="break-all font-mono">{shareUrl}</span>
              <Button size="sm" variant="ghost" onClick={() => {
                navigator.clipboard.writeText(shareUrl).then(
                  () => toast.success('Link copied'),
                  () => toast.error('Could not copy'),
                );
              }}>
                <Copy className="mr-1 h-3 w-3" /> Copy
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <a href={shareUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" /> Open
                </a>
              </Button>
            </div>
          )}
          <Button onClick={runCheck} disabled={running || !shareUrl}>
            {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run preview check
          </Button>
          <p className="text-xs text-muted-foreground">
            Verification runs with <code>verify=1</code>, so these checks never count as real
            share opens in the analytics dashboard.
          </p>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {result && (
        <>
          <Card className={allPass ? 'border-emerald-500' : 'border-amber-500'}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">2. Checks</CardTitle>
              <Badge variant={allPass ? 'default' : 'secondary'}>
                {checks.filter((c) => c.pass).length}/{checks.length} passed
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-2 text-sm">
                  {c.pass
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    : <XCircle className="h-4 w-4 text-destructive" />}
                  <span className={c.pass ? '' : 'text-destructive'}>{c.label}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">3. How WhatsApp will render it</CardTitle></CardHeader>
            <CardContent>
              <div className="mx-auto max-w-sm rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/40">
                <div className="overflow-hidden rounded-lg bg-card shadow">
                  {ogImage
                    ? <img src={ogImage} alt={ogTitle || 'Preview image'} className="h-44 w-full object-cover" />
                    : <div className="flex h-44 items-center justify-center text-xs text-muted-foreground">No og:image</div>}
                  <div className="space-y-1 p-3">
                    <p className="line-clamp-2 text-sm font-semibold">{ogTitle || '—'}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{ogDesc || '—'}</p>
                    <p className="text-xs uppercase text-muted-foreground">{previewHost || '—'}</p>
                  </div>
                </div>
                <p className="mt-2 break-all text-xs text-muted-foreground">{result.url}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">4. Tags returned</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {Object.entries(tags).map(([k, v]) => (
                      <tr key={k} className="border-b last:border-0">
                        <td className="py-1 pr-3 font-mono font-medium">{k}</td>
                        <td className="break-all py-1">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                WhatsApp and Facebook cache previews. After changing an image or title, force a
                refresh in the platform's link preview debugger, or the old card may still show.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
