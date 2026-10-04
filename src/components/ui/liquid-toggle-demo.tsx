"use client";

import { useState } from "react";
import { Toggle, GooeyFilter } from "@/components/ui/liquid-toggle";

function ToggleWithState({
  variant,
}: {
  variant: "default" | "success" | "warning" | "danger";
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <Toggle variant={variant} checked={checked} onCheckedChange={setChecked} />
      <span className="text-sm text-muted-foreground capitalize">{variant}</span>
    </div>
  );
}

export function DefaultToggleDemo() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <GooeyFilter />
      <ToggleWithState variant="default" />
    </div>
  );
}

export function SuccessToggleDemo() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <GooeyFilter />
      <ToggleWithState variant="success" />
    </div>
  );
}

export function WarningToggleDemo() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <GooeyFilter />
      <ToggleWithState variant="warning" />
    </div>
  );
}

export function DangerToggleDemo() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <GooeyFilter />
      <ToggleWithState variant="danger" />
    </div>
  );
}

export { ToggleWithState };
