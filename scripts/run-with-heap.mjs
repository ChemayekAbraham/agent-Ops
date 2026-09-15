#!/usr/bin/env node
/**
 * Cross-platform heap-cap wrapper.
 *
 * Guarantees an 8 GB V8 old-space cap for every child process in the build
 * pipeline, regardless of shell (POSIX `VAR=x cmd` syntax does not work on
 * Windows/cmd and is not applied by some CI runners that invoke scripts with
 * their own shell). Existing NODE_OPTIONS are preserved, but any inherited
 * `--max-old-space-size` is replaced so a smaller ambient cap (some CI images
 * export one globally) can never shrink the build heap.
 *
 * Usage: node scripts/run-with-heap.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Default heap is deliberately conservative (4 GB). The publish build container
 * is much smaller than a dev machine, and `os.totalmem()` reports HOST memory
 * when no cgroup file is readable — so an 8 GB request could survive the
 * ceiling check below and then get OOM-killed (SIGKILL) mid-`vite build`, which
 * surfaces as an opaque "Publishing failed because of an error in your app".
 * This project builds comfortably under 4 GB; raise via BUILD_HEAP_MB if ever
 * needed.
 */
// 3072 MB was no longer enough: `vite build` reached the gzip-size step and died
// with an ineffective mark-compact SIGABRT. The ceiling check below still keeps
// this request inside whatever the container actually has, so a larger request
// is safe on small publish containers and only takes effect where memory exists.
const REQUESTED_HEAP_MB = Number(process.env.BUILD_HEAP_MB || 6144);

/**
 * Hard ceiling available to this container. Forcing an 8 GB V8 heap inside a
 * smaller build container is worse than a small heap: V8 happily grows past the
 * cgroup limit and the kernel OOM-kills the process (SIGKILL), which surfaces
 * as an opaque "Publishing failed" with no build error. So cap the heap at a
 * safe fraction of whatever memory this machine actually has.
 */
function containerMemoryMb() {
  const candidates = [];
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(file, 'utf8').trim();
      if (raw && raw !== 'max') {
        const bytes = Number(raw);
        if (Number.isFinite(bytes) && bytes > 0 && bytes < Number.MAX_SAFE_INTEGER) {
          candidates.push(Math.floor(bytes / 1024 / 1024));
        }
      }
    } catch {
      // cgroup file unavailable (macOS / Windows / restricted CI) — ignore.
    }
  }
  const total = Math.floor(os.totalmem() / 1024 / 1024);
  if (Number.isFinite(total) && total > 0) candidates.push(total);
  return candidates.length ? Math.min(...candidates) : null;
}

const memoryMb = containerMemoryMb();
// Leave headroom for the OS, the Rollup native addon and worker threads.
const safeCeilingMb = memoryMb ? Math.max(1536, Math.floor(memoryMb * 0.75)) : REQUESTED_HEAP_MB;
const HEAP_MB = Math.min(REQUESTED_HEAP_MB, safeCeilingMb);

const [rawCommand, ...rawArgs] = process.argv.slice(2);

if (!rawCommand) {
  console.error('[heap] usage: node scripts/run-with-heap.mjs <command> [args...]');
  process.exit(1);
}

// Always execute through this Node binary so NODE_OPTIONS is guaranteed to apply.
// Shell shims (npx / node_modules/.bin) can re-exec through another runtime
// (bun, for example) that ignores NODE_OPTIONS, which is how a smaller ambient
// heap cap silently survives into the build.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveJsEntry(name) {
  const candidates = [
    path.join(projectRoot, 'node_modules', name, 'bin', `${name}.js`),
    path.join(projectRoot, 'node_modules', name, 'bin', `${name}.mjs`),
    path.join(projectRoot, 'node_modules', '.bin', name),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

let command = rawCommand;
let args = rawArgs;

if (rawCommand !== 'node' && rawCommand !== process.execPath) {
  const entry = resolveJsEntry(rawCommand);
  if (!entry) {
    console.error(`[heap] could not resolve local executable "${rawCommand}"`);
    process.exit(1);
  }
  command = process.execPath;
  args = [entry, ...rawArgs];
} else {
  command = process.execPath;
}

const existing = process.env.NODE_OPTIONS ?? '';
const heapMb = HEAP_MB;
const nodeOptions = `${existing.replace(/--max-old-space-size=\d+/g, '').trim()} --max-old-space-size=${heapMb}`.trim();

console.log(
  `[heap] machine=${memoryMb ?? 'unknown'}MB requested=${REQUESTED_HEAP_MB}MB using=${heapMb}MB -> ${command} ${args.join(' ')}`,
);

if (heapMb < REQUESTED_HEAP_MB) {
  console.warn(
    `[heap] NOTE: requested ${REQUESTED_HEAP_MB}MB was clamped to ${heapMb}MB ` +
      `(75% of ${memoryMb}MB detected). If a build ever OOMs, the ceiling — not BUILD_HEAP_MB — is the limit.`,
  );
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

child.on('error', (error) => {
  console.error(`[heap] failed to start "${command}":`, error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[heap] "${command}" terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
