import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  backupFileName,
  backupFilesToDelete,
  generateBackupPassword,
  kampalaStamp,
  rowDriftAcceptable,
} from "./partnerTenantBackup.ts";

Deno.test("password: length, alphabet, and differs between calls", () => {
  const a = generateBackupPassword();
  const b = generateBackupPassword();
  assertEquals(a.length, 24);
  assert(/^[A-HJ-NP-Za-km-z2-9]+$/.test(a));
  assert(a !== b);
});

Deno.test("kampala stamp: 23:00 UTC is 02:00 the next day", () => {
  assertEquals(kampalaStamp(new Date("2026-10-22T23:00:00Z")), { day: "2026-10-23", time: "0200" });
  assertEquals(backupFileName(new Date("2026-10-22T23:00:00Z")), "welile-partner-tenant_2026-10-23_0200.zip");
});

const f = (day: string, time = "0200") => `welile-partner-tenant_${day}_${time}.zip`;
const all = (names: string[]) => new Set(names);

Deno.test("rotation: 8th day deletes the oldest", () => {
  const names = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].map((d) => f(d));
  assertEquals(backupFilesToDelete(names, all(names)), [f("2026-10-16")]);
});

Deno.test("rotation: 7 or fewer days deletes nothing", () => {
  const names = [f("2026-10-20"), f("2026-10-21")];
  assertEquals(backupFilesToDelete(names, all(names)), []);
});

Deno.test("rotation: same-day re-run keeps only the newest of that day", () => {
  const names = [f("2026-10-22", "0200"), f("2026-10-22", "1130")];
  assertEquals(backupFilesToDelete(names, all(names)), [f("2026-10-22", "0200")]);
});

Deno.test("rotation: missed days keep 7 good backups, not 7 calendar days", () => {
  const names = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-20"].map((d) => f(d));
  assertEquals(backupFilesToDelete(names, all(names)), [f("2026-10-01")]);
});

Deno.test("rotation: ignores files that are not backups", () => {
  const names = ["notes.txt", ".emptyFolderPlaceholder", f("2026-10-22")];
  assertEquals(backupFilesToDelete(names, all([f("2026-10-22")])), []);
});

Deno.test("rotation: unverified leftovers are deleted and do not use up a day", () => {
  const good = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].map((d) => f(d));
  const killed = f("2026-10-22", "1155");
  assertEquals(backupFilesToDelete([...good, killed], all(good)), [killed]);
});

Deno.test("rotation: a file another run is still checking is left alone", () => {
  const checking = f("2026-10-23", "0900");
  assertEquals(backupFilesToDelete([f("2026-10-23"), checking], all([f("2026-10-23")]), all([checking])), []);
});

Deno.test("drift: small gaps pass, missing rows fail", () => {
  assert(rowDriftAcceptable(6779, 6781));
  assert(rowDriftAcceptable(0, 0));
  assert(!rowDriftAcceptable(6779, 0));
  assert(!rowDriftAcceptable(20327, 19000));
});
