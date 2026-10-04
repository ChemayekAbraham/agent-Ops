import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { GenerateLinkDialog } from "@/pages/AgentCampaignsPage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { UgDistrictSelect, type UgDistrictValue } from "@/components/location/UgDistrictSelect";
import { useUgDistricts, findUgDistrictByName } from "@/hooks/useUgLocations";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  objective: string | null;
  start_date: string;
  end_date: string | null;
  status: "draft" | "active" | "paused" | "completed";
};
type Analytics = {
  summary: Record<string, number>;
  by_location: Array<Record<string, any>>;
  by_source: Array<Record<string, any>>;
  by_agent: Array<Record<string, any>>;
  funnel: Record<string, number>;
};

function pct(num: number, den: number) {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export default function AdminRecruitmentCampaignsPage() {
  const qc = useQueryClient();
  const [campaignId, setCampaignId] = useState<string>("");

  const campaignsQ = useQuery({
    queryKey: ["admin-campaigns"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recruitment_campaigns")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Campaign[];
    },
  });

  const locationsQ = useQuery({
    queryKey: ["recruitment-locations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recruitment_locations")
        .select("id, district, display_name, slug, region, ug_district_id, city, division, is_active")
        .eq("is_active", true)
        .order("district");
      if (error) throw error;
      return (data ?? []) as any[];
    },
    staleTime: 300_000,
  });

  const analyticsQ = useQuery({
    queryKey: ["admin-campaign-analytics", campaignId || null],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "get_admin_campaign_analytics",
        { p_campaign_id: campaignId || null, p_from: null, p_to: null },
      );
      if (error) throw error;
      return data as unknown as Analytics;
    },
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Campaign["status"] }) => {
      const { error } = await supabase
        .from("recruitment_campaigns")
        .update({ status })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Campaign updated");
      qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      qc.invalidateQueries({ queryKey: ["admin-campaign-analytics"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const deleteCampaign = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("recruitment_campaigns")
        .delete()
        .eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      toast.success("Campaign deleted");
      if (campaignId === id) setCampaignId("");
      qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      qc.invalidateQueries({ queryKey: ["admin-campaign-analytics"] });
    },
    onError: (e: any) =>
      toast.error(
        e?.message?.includes("foreign key")
          ? "This campaign has links or registrations attached. Complete or archive it instead."
          : e?.message ?? "Failed to delete",
      ),
  });

  const summary = analyticsQ.data?.summary ?? {};
  const funnel = analyticsQ.data?.funnel ?? {};

  return (
    <div className="container mx-auto py-6 px-4 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            Field Recruitment Campaigns
          </h1>
          <p className="text-sm text-muted-foreground">
            Track agent-driven sub-agent recruitment by location and source.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <GenerateLinkDialog
            campaigns={(campaignsQ.data ?? []) as any}
            onCreated={() => qc.invalidateQueries({ queryKey: ["admin-campaign-analytics"] })}
            showAgentPicker
          />
          <CreateCampaignDialog
            onCreated={() => qc.invalidateQueries({ queryKey: ["admin-campaigns"] })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs uppercase text-muted-foreground">Filter campaign:</Label>
        <Select value={campaignId || "all"} onValueChange={(v) => setCampaignId(v === "all" ? "" : v)}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All campaigns</SelectItem>
            {(campaignsQ.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Campaigns" value={summary.campaigns} />
        <Tile label="Active" value={summary.active_campaigns} />
        <Tile label="Agents" value={summary.agents} />
        <Tile label="Links" value={summary.links} />
        <Tile label="Clicks" value={summary.clicks} />
        <Tile label="Unique clicks" value={summary.unique_clicks} />
        <Tile label="Registrations" value={summary.registrations} />
        <Tile label="Sub-agents" value={summary.sub_agents} />
        <Tile label="Qualified" value={summary.qualified} />
        <Tile label="Rewards qualified" value={summary.rewards_qualified} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Objective</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Start</th>
                  <th className="text-left px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(campaignsQ.data ?? []).map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {c.objective ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={c.status === "active" ? "default" : "secondary"}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{c.start_date}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {c.status !== "active" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setStatus.mutate({ id: c.id, status: "active" })
                            }
                          >
                            Activate
                          </Button>
                        )}
                        {c.status === "active" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setStatus.mutate({ id: c.id, status: "paused" })
                            }
                          >
                            Pause
                          </Button>
                        )}
                        {c.status !== "completed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setStatus.mutate({ id: c.id, status: "completed" })
                            }
                          >
                            Complete
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={deleteCampaign.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete “{c.name}”?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This permanently removes the campaign. Links or
                                registrations already attached to it will block
                                deletion — mark it Completed instead if that
                                happens. This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => deleteCampaign.mutate(c.id)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </td>
                  </tr>
                ))}
                {(campaignsQ.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      No campaigns yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4">
        <PerfTable
          title="Performance by location"
          rows={analyticsQ.data?.by_location ?? []}
          columns={[
            { key: "district", label: "District", render: (r) => r.district ?? "—" },
            { key: "links", label: "Links", right: true },
            { key: "clicks", label: "Clicks", right: true },
            { key: "unique_clicks", label: "Unique", right: true },
            { key: "registrations", label: "Regs", right: true },
            { key: "sub_agents", label: "Sub-agents", right: true },
            { key: "qualified", label: "Qualified", right: true },
            {
              key: "conv",
              label: "Click → Reg",
              right: true,
              render: (r) => pct(r.registrations, r.unique_clicks),
            },
          ]}
        />
        <PerfTable
          title="Performance by source"
          rows={analyticsQ.data?.by_source ?? []}
          columns={[
            {
              key: "selected_source",
              label: "Source",
              render: (r) =>
                String(r.selected_source ?? "")
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c: string) => c.toUpperCase()),
            },
            { key: "links", label: "Links", right: true },
            { key: "clicks", label: "Clicks", right: true },
            { key: "unique_clicks", label: "Unique", right: true },
            { key: "registrations", label: "Regs", right: true },
            { key: "sub_agents", label: "Sub-agents", right: true },
            { key: "qualified", label: "Qualified", right: true },
            {
              key: "conv",
              label: "Click → Reg",
              right: true,
              render: (r) => pct(r.registrations, r.unique_clicks),
            },
          ]}
        />
      </div>

      <RecruitmentLocationsCard
        locations={locationsQ.data ?? []}
        onChanged={() => qc.invalidateQueries({ queryKey: ["recruitment-locations"] })}
      />

      <PerfTable
        title="Performance by agent"
        rows={analyticsQ.data?.by_agent ?? []}
        columns={[
          { key: "agent_name", label: "Agent", render: (r) => r.agent_name ?? r.agent_id },
          {
            key: "districts",
            label: "District(s)",
            render: (r) => (r.districts ? String(r.districts) : "—"),
          },
          { key: "links", label: "Links", right: true },
          { key: "clicks", label: "Clicks", right: true },
          { key: "registrations", label: "Regs", right: true },
          { key: "sub_agents", label: "Sub-agents", right: true },
          { key: "qualified", label: "Qualified", right: true },
          {
            key: "conv",
            label: "Click → Reg",
            right: true,
            render: (r) => pct(r.registrations, r.unique_clicks ?? r.clicks),
          },
        ]}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Campaign funnel</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {[
              ["Links generated", funnel.links],
              ["Clicks", funnel.clicks],
              ["Registrations", funnel.registrations],
              ["Sub-agents", funnel.sub_agents],
              ["1st verified house", funnel.one_house],
              ["2nd verified house", funnel.two_houses],
              ["3rd verified house", funnel.three_houses],
              ["UGX 10,000 reward qualified", funnel.reward_qualified],
              ["UGX 10,000 reward paid", funnel.reward_paid],
            ].map(([label, v]) => (
              <div key={label as string} className="flex items-center justify-between border-b py-1">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-semibold">
                  {Number(v ?? 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function slugify(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Manage the recruitment location catalogue. District comes from the official
 * ug_districts dataset and the region is derived from it — never typed.
 * Link generation, attribution and QR flows are untouched.
 */
function RecruitmentLocationsCard({
  locations,
  onChanged,
}: {
  locations: any[];
  onChanged: () => void;
}) {
  const { data: districts } = useUgDistricts();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [district, setDistrict] = useState<UgDistrictValue | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [city, setCity] = useState("");
  const [division, setDivision] = useState("");
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setDistrict(null);
    setDisplayName("");
    setCity("");
    setDivision("");
    setOpen(true);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    const match =
      row.ug_district_id != null
        ? (districts ?? []).find((d) => d.id === row.ug_district_id) ?? null
        : findUgDistrictByName(districts, row.district);
    setDistrict(match ? { id: match.id, name: match.name, region: match.region ?? null } : null);
    setDisplayName(row.display_name ?? "");
    setCity(row.city ?? "");
    setDivision(row.division ?? "");
    setOpen(true);
  };

  const save = async () => {
    if (!district) {
      toast.error("Select the official district");
      return;
    }
    const name = displayName.trim() || district.name;
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        district: district.name,
        region: district.region ?? null,
        ug_district_id: district.id,
        display_name: name,
        city: city.trim() || null,
        division: division.trim() || null,
      };
      if (editing) {
        const { error } = await supabase
          .from("recruitment_locations")
          .update(payload)
          .eq("id", editing.id);
        if (error) throw error;
        toast.success("Location updated");
      } else {
        const { error } = await supabase.from("recruitment_locations").insert([
          {
            ...payload,
            country: "UG",
            slug: slugify([district.name, division.trim() || city.trim()].filter(Boolean).join("-")),
            is_active: true,
          },
        ] as any);
        if (error) throw error;
        toast.success("Location created");
      }
      setOpen(false);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save location");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Recruitment locations</CardTitle>
        <Button size="sm" onClick={openCreate}>Add location</Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Display name</th>
                <th className="py-2">District</th>
                <th className="py-2">Region</th>
                <th className="py-2">Slug</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-2">{l.display_name}</td>
                  <td className="py-2">{l.district}</td>
                  <td className="py-2">
                    {l.region ?? "—"}
                    {l.ug_district_id == null && (
                      <Badge variant="outline" className="ml-2 text-[10px]">unlinked</Badge>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs text-muted-foreground">{l.slug}</td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(l)}>Edit</Button>
                  </td>
                </tr>
              ))}
              {locations.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted-foreground">
                    No locations yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit location" : "Add location"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <UgDistrictSelect
              value={district}
              onChange={(v) => {
                setDistrict(v);
                if (v && !displayName.trim()) setDisplayName(v.name);
              }}
              required
              legacyText={editing?.district ?? null}
            />
            <div className="space-y-1.5">
              <Label>Display name</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Shown to agents"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>City (optional)</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Division (optional)</Label>
                <Input value={division} onChange={(e) => setDivision(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {editing ? "Save changes" : "Create location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold text-foreground">
        {Number(value ?? 0).toLocaleString()}
      </div>
    </div>
  );
}

type Col = {
  key: string;
  label: string;
  right?: boolean;
  render?: (r: any) => React.ReactNode;
};
function PerfTable({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Array<Record<string, any>>;
  columns: Col[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-3 py-2 ${c.right ? "text-right" : "text-left"}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="py-6 text-center text-muted-foreground"
                  >
                    No data.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 ${c.right ? "text-right" : "text-left"}`}
                      >
                        {c.render
                          ? c.render(r)
                          : Number(r[c.key] ?? 0).toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-muted/30 font-semibold border-t">
                <tr>
                  {columns.map((c, idx) => {
                    if (idx === 0) {
                      return (
                        <td key={c.key} className="px-3 py-2 text-left">
                          Total
                        </td>
                      );
                    }
                    const sum = (key: string) =>
                      rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
                    let content: React.ReactNode = "";
                    if (c.key === "conv") {
                      const regs = sum("registrations");
                      const denom =
                        sum("unique_clicks") || sum("clicks");
                      content = pct(regs, denom);
                    } else if (c.right) {
                      content = sum(c.key).toLocaleString();
                    }
                    return (
                      <td
                        key={c.key}
                        className={`px-3 py-2 ${c.right ? "text-right" : "text-left"}`}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateCampaignDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Campaign["status"]>("active");
  const [pending, setPending] = useState(false);

  const create = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setPending(true);
    const { error } = await supabase.from("recruitment_campaigns").insert({
      name: name.trim(),
      objective: objective.trim() || null,
      description: description.trim() || null,
      status,
    });
    setPending(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Campaign created");
    setOpen(false);
    setName("");
    setObjective("");
    setDescription("");
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New campaign</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New recruitment campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Objective</Label>
            <Input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Recruit and activate new sub-agents"
            />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={pending}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}