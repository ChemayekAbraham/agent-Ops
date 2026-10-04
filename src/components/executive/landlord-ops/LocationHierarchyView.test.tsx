import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import {
  LocationHierarchyView,
  type HierarchyHouse,
} from "./LocationHierarchyView";

const baseHouse = (over: Partial<HierarchyHouse>): HierarchyHouse => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: over.title ?? "House",
  address: over.address ?? "addr",
  region: over.region ?? "",
  district: over.district ?? null,
  status: "available",
  monthly_rent: 100000,
  daily_rate: 3500,
  agent_id: over.agent_id ?? "agent-1",
  landlord_id: over.landlord_id ?? "landlord-1",
  tenant_id: over.tenant_id ?? null,
  is_hidden: false,
  ...over,
});

const profiles = {
  "agent-1": { name: "Agent One", phone: "+256700000001" },
  "landlord-1": { name: "Landlord One", phone: "+256700000002" },
};

/** Collect the visible top-level region row titles (depth 1). */
function visibleRegionTitles(): string[] {
  // Region rows render <MapPin> with a sky-600 class. Easiest: read the
  // titles we expect by querying the unique text content of region buttons.
  // The structure puts region title in a span.font-semibold inside a button
  // at paddingLeft 20 (= 8 + 1*12). We grab all such buttons.
  const buttons = screen.getAllByRole("button");
  return buttons
    .filter((b) => (b as HTMLElement).style.paddingLeft === "20px")
    .map((b) => within(b).getByText(/.+/, { selector: "span.font-semibold" }).textContent ?? "");
}

function openCountry() {
  // Country row is open by default in the component, nothing to do.
}

describe("LocationHierarchyView — Uganda region grouping", () => {
  it("collapses Kampala, Wakiso, Entebbe, Nansana under a single 'Central' region", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "Kampala" }),
      baseHouse({ id: "h2", region: "Wakiso" }),
      baseHouse({ id: "h3", region: "Entebbe" }),
      baseHouse({ id: "h4", region: "Nansana" }),
      baseHouse({ id: "h5", region: "Central" }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    openCountry();

    const regions = visibleRegionTitles();
    expect(regions).toEqual(["Central"]);
  });

  it("groups Eastern and Western districts under correct regions", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "Jinja" }),
      baseHouse({ id: "h2", region: "Mbale" }),
      baseHouse({ id: "h3", region: "Mbarara" }),
      baseHouse({ id: "h4", region: "Kasese" }),
      baseHouse({ id: "h5", region: "Gulu" }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    const regions = visibleRegionTitles().sort();
    expect(regions).toEqual(["Eastern", "Northern", "Western"]);
  });

  it("normalizes case-variants of region names", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "central" }),
      baseHouse({ id: "h2", region: "CENTRAL" }),
      baseHouse({ id: "h3", region: "Central Region" }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    expect(visibleRegionTitles()).toEqual(["Central"]);
  });

  it("derives region from district when region is missing", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "", district: "Kampala" }),
      baseHouse({ id: "h2", region: "", district: "Wakiso" }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    expect(visibleRegionTitles()).toEqual(["Central"]);
  });

  it("rolls Entebbe/Nansana cities up to Wakiso district under Central", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "Entebbe" }),
      baseHouse({ id: "h2", region: "Nansana" }),
      baseHouse({ id: "h3", region: "Wakiso" }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    // Only Central visible
    expect(visibleRegionTitles()).toEqual(["Central"]);

    // Expand Central and verify the only district is Wakiso
    const centralBtn = screen.getAllByRole("button").find(
      (b) =>
        (b as HTMLElement).style.paddingLeft === "20px" &&
        b.textContent?.includes("Central"),
    )!;
    fireEvent.click(centralBtn);

    const districtTitles = screen
      .getAllByRole("button")
      .filter((b) => (b as HTMLElement).style.paddingLeft === "32px")
      .map(
        (b) =>
          within(b).getByText(/.+/, { selector: "span.font-semibold" })
            .textContent ?? "",
      );
    expect(districtTitles).toEqual(["Wakiso"]);
  });

  it("aggregates total / occupied / vacant counts correctly under Central", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "Kampala", tenant_id: "t1" }),
      baseHouse({ id: "h2", region: "Wakiso", tenant_id: null }),
      baseHouse({ id: "h3", region: "Entebbe", tenant_id: "t2" }),
      baseHouse({ id: "h4", region: "Nansana", tenant_id: null }),
    ];
    render(<LocationHierarchyView houses={houses} profiles={profiles} />);
    const centralBtn = screen.getAllByRole("button").find(
      (b) =>
        (b as HTMLElement).style.paddingLeft === "20px" &&
        b.textContent?.includes("Central"),
    )!;
    expect(centralBtn.textContent).toContain("4 houses");
    expect(centralBtn.textContent).toContain("2 occ");
    expect(centralBtn.textContent).toContain("2 vac");
  });

  it("does not normalize when country is not Uganda", () => {
    const houses: HierarchyHouse[] = [
      baseHouse({ id: "h1", region: "Nairobi" }),
      baseHouse({ id: "h2", region: "Mombasa" }),
    ];
    render(
      <LocationHierarchyView
        houses={houses}
        profiles={profiles}
        country="Kenya"
      />,
    );
    expect(visibleRegionTitles().sort()).toEqual(["Mombasa", "Nairobi"]);
  });
});
