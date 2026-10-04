import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeCanvas } from "qrcode.react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Copy, Share2, QrCode, Download, Ban, Link as LinkIcon } from "lucide-react";
import { format } from "date-fns";
import { UserSearchPicker } from "@/components/cfo/UserSearchPicker";
import { UgDistrictSelect, type UgDistrictValue } from "@/components/location/UgDistrictSelect";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  objective: string | null;
  status: string;
};
type LinkRow = {
  id: string;
  short_code: string;
  campaign_id: string;
  campaign_name: string;
  location_id: string | null;
  location_display: string;
  district_name: string | null;
  location_slug: string;
  selected_source: string;
  link_type: string;
  placement_name: string | null;
  status: string;
  total_clicks: number;
  unique_clicks: number;
  total_registrations: number;
  total_sub_agent_registrations: number;
  qualified_sub_agents: number;
  created_at: string;
};
type Location = {
  id: string;
  district: string;
  display_name: string;
  slug: string;
  region: string | null;
};

const SOURCES = [
  "whatsapp",
  "facebook",
  "tiktok",
  "sms",
  "qr_sticker",
  "printed_poster",
  "direct_link",
  "agent_assisted",
  "other",
] as const;
const LINK_TYPES = [
  "general_campaign_link",
  "qr_sticker",
  "printed_poster",
  "assisted_registration",
  "social_share",
] as const;

function shortLinkUrl(code: string, slug: string) {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://welileapp.com";
  return `${origin}/c/${slug}/${code}`;
}

function labelize(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AgentCampaignsPage() {
  const qc = useQueryClient();
  const dashboardQ = useQuery({
    queryKey: ["agent-campaign-dashboard"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_agent_campaign_dashboard");
      if (error) throw error;
      return data as {
        campaigns: Campaign[];
        links: LinkRow[];
        totals: Record<string, number>;
      };
    },
    staleTime: 30_000,
  });

  const locationsQ = useQuery({
    queryKey: ["recruitment-locations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recruitment_locations")
        .select("id, district, display_name, slug, region")
        .eq("is_active", true)
        .order("district");
      if (error) throw error;
      return data as Location[];
    },
    staleTime: 300_000,
  });

  const campaigns = dashboardQ.data?.campaigns ?? [];
  const links = dashboardQ.data?.links ?? [];
  const totals = dashboardQ.data?.totals ?? {};

  const [qrLink, setQrLink] = useState<LinkRow | null>(null);

  return (
    <div className="container mx-auto py-6 px-4 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Campaign Tracking</h1>
          <p className="text-sm text-muted-foreground">
            Generate campaign links, share QR codes, and track recruitment.
          </p>
        </div>
        <GenerateLinkDialog
          campaigns={campaigns}
          locations={locationsQ.data ?? []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["agent-campaign-dashboard"] })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <MetricTile label="Links" value={totals.links ?? 0} />
        <MetricTile label="Clicks" value={totals.clicks ?? 0} />
        <MetricTile label="Unique" value={totals.unique_clicks ?? 0} />
        <MetricTile label="Registrations" value={totals.registrations ?? 0} />
        <MetricTile label="Sub-agents" value={totals.sub_agents ?? 0} />
        <MetricTile label="Qualified" value={totals.qualified ?? 0} />
      </div>

      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No active campaigns right now. Check back once your admin activates one.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <Badge variant="secondary">{c.status}</Badge>
                </div>
                {c.objective ? (
                  <p className="text-xs text-muted-foreground">{c.objective}</p>
                ) : null}
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {c.description ?? "—"}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">My campaign links</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {links.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              You haven't generated any campaign links yet.
            </div>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="min-w-[880px] w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Link</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Campaign</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Location</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Source</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Clicks</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Unique</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Regs</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Sub-agents</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Qualified</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Status</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <LinkRowUI
                      key={l.id}
                      link={l}
                      onQr={() => setQrLink(l)}
                      onDisabled={() =>
                        qc.invalidateQueries({ queryKey: ["agent-campaign-dashboard"] })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <QRDialog link={qrLink} onClose={() => setQrLink(null)} />
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold text-foreground">
        {Number(value ?? 0).toLocaleString()}
      </div>
    </div>
  );
}

function LinkRowUI({
  link,
  onQr,
  onDisabled,
}: {
  link: LinkRow;
  onQr: () => void;
  onDisabled: () => void;
}) {
  const url = shortLinkUrl(link.short_code, link.location_slug);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  };
  const share = async () => {
    if ((navigator as any).share) {
      try {
        await (navigator as any).share({ title: link.campaign_name, url });
      } catch {
        /* user cancelled */
      }
    } else {
      await copy();
    }
  };
  const disable = async () => {
    if (!confirm("Disable this link? It can no longer be used.")) return;
    const { error } = await supabase.rpc("disable_campaign_link", {
      p_link_id: link.id,
      p_reason: "agent_disabled",
    });
    if (error) toast.error(error.message);
    else {
      toast.success("Link disabled");
      onDisabled();
    }
  };
  return (
    <tr className="border-t">
      <td className="px-3 py-2 whitespace-nowrap">
        <button
          className="text-primary underline underline-offset-2 font-mono"
          onClick={copy}
          title="Copy"
        >
          /c/{link.location_slug}/{link.short_code}
        </button>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{link.campaign_name}</td>
      <td className="px-3 py-2 whitespace-nowrap">{link.district_name || link.location_display || "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">{labelize(link.selected_source)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{link.total_clicks}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{link.unique_clicks}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{link.total_registrations}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {link.total_sub_agent_registrations}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{link.qualified_sub_agents}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <Badge variant={link.status === "active" ? "default" : "secondary"}>
          {link.status}
        </Badge>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={copy} title="Copy link">
            <Copy className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={share} title="Share">
            <Share2 className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onQr} title="QR code">
            <QrCode className="w-4 h-4" />
          </Button>
          {link.status === "active" ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={disable}
              title="Disable link"
            >
              <Ban className="w-4 h-4" />
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export function GenerateLinkDialog({
  campaigns,
  onCreated,
  showAgentPicker = false,
  locations: _locations,
}: {
  campaigns: Campaign[];
  locations?: Location[];
  onCreated: () => void;
  showAgentPicker?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [districtName, setDistrictName] = useState("");
  /** Official ug_districts unit behind districtName. */
  const [districtUnit, setDistrictUnit] = useState<UgDistrictValue | null>(null);
  const [ownerAgent, setOwnerAgent] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [source, setSource] = useState<(typeof SOURCES)[number]>("whatsapp");
  const [linkType, setLinkType] =
    useState<(typeof LINK_TYPES)[number]>("general_campaign_link");
  const [placement, setPlacement] = useState("");
  const [result, setResult] = useState<LinkRow | null>(null);

  const activeCampaigns = useMemo(
    () => campaigns.filter((c) => c.status === "active"),
    [campaigns],
  );

  const districtTrimmed = districtName.trim();
  const districtValid =
    districtTrimmed.length >= 2 &&
    districtTrimmed.length <= 80 &&
    /[A-Za-z]/.test(districtTrimmed);

  const create = useMutation({
    mutationFn: async () => {
      if (!campaignId) throw new Error("Select a campaign");
      if (!districtValid) {
        throw new Error(
          "Enter a valid district (2–80 characters, must contain letters)",
        );
      }
      if (showAgentPicker && !ownerAgent) {
        throw new Error("Select the agent who will own this link");
      }
      const { data, error } = await supabase.rpc("create_campaign_link", {
        p_campaign_id: campaignId,
        p_district_name: districtTrimmed,
        p_selected_source: source,
        p_link_type: linkType,
        p_placement_name: placement || null,
        p_agent_id: showAgentPicker && ownerAgent ? ownerAgent.id : null,
      });
      if (error) throw error;
      return data as unknown as LinkRow;
    },
    onSuccess: (row) => {
      const camp = campaigns.find((c) => c.id === row.campaign_id);
      setResult({
        ...(row as any),
        campaign_name: camp?.name ?? "",
        location_display: row.district_name ?? "",
      });
      onCreated();
      toast.success("Campaign link generated");
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to generate link"),
  });

  const url = result ? shortLinkUrl(result.short_code, result.location_slug) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <LinkIcon className="w-4 h-4 mr-2" /> Generate link
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate campaign link</DialogTitle>
        </DialogHeader>
        {!result ? (
          <div className="space-y-3">
            <div>
              <Label>Campaign</Label>
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select campaign" />
                </SelectTrigger>
                <SelectContent>
                  {activeCampaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <UgDistrictSelect
                label="District"
                legacyText={districtName}
                value={districtUnit}
                onChange={(unit) => {
                  setDistrictUnit(unit);
                  setDistrictName(unit?.name ?? '');
                }}
              />
              <p className="text-xs text-muted-foreground mt-1">
                One link covers the entire district. The agent may use it anywhere
                in the district.
              </p>
            </div>
            {showAgentPicker && (
              <div>
                <UserSearchPicker
                  label="Referral agent (owner)"
                  placeholder="Search agent by name or phone"
                  selectedUser={ownerAgent}
                  onSelect={setOwnerAgent}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Selected source</Label>
                <Select
                  value={source}
                  onValueChange={(v) => setSource(v as any)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {labelize(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Link type</Label>
                <Select
                  value={linkType}
                  onValueChange={(v) => setLinkType(v as any)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINK_TYPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {labelize(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Placement name (optional)</Label>
              <Input
                value={placement}
                onChange={(e) => setPlacement(e.target.value)}
                placeholder="e.g. Mbale QR stickers (internal label only)"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Internal label to distinguish links. Not a physical location.
              </p>
            </div>
            <DialogFooter>
              <Button
                onClick={() => create.mutate()}
                disabled={create.isPending || !campaignId || !districtValid}
              >
                {create.isPending ? "Generating…" : "Generate campaign link"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <GeneratedLinkView url={url} link={result} onClose={() => setOpen(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GeneratedLinkView({
  url,
  link,
  onClose,
}: {
  url: string;
  link: LinkRow;
  onClose: () => void;
}) {
  const downloadQr = () => {
    const canvas = document.getElementById("gen-qr") as HTMLCanvasElement | null;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `welile-campaign-${link.short_code}.png`;
    a.click();
  };
  return (
    <div className="space-y-4 text-center">
      <p className="text-sm text-muted-foreground">
        Share this link or print the QR code.
      </p>
      <div className="flex justify-center">
        <QRCodeCanvas id="gen-qr" value={url} size={192} includeMargin />
      </div>
      <div className="rounded-md border bg-muted/30 p-2 text-sm font-mono break-all">
        {url}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            navigator.clipboard.writeText(url);
            toast.success("Copied");
          }}
        >
          <Copy className="w-4 h-4 mr-1" /> Copy
        </Button>
        <Button variant="secondary" onClick={downloadQr}>
          <Download className="w-4 h-4 mr-1" /> Download QR
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function QRDialog({
  link,
  onClose,
}: {
  link: LinkRow | null;
  onClose: () => void;
}) {
  if (!link) return null;
  const url = shortLinkUrl(link.short_code, link.location_slug);
  const download = () => {
    const canvas = document.getElementById("row-qr") as HTMLCanvasElement | null;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `welile-campaign-${link.short_code}.png`;
    a.click();
  };
  return (
    <Dialog open={!!link} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{link.campaign_name}</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center py-3">
          <QRCodeCanvas id="row-qr" value={url} size={200} includeMargin />
        </div>
        <div className="text-center text-xs text-muted-foreground break-all">
          {url}
        </div>
        <div className="text-center text-xs text-muted-foreground">
          Created {format(new Date(link.created_at), "PP")}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={download}>
            <Download className="w-4 h-4 mr-1" /> Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}