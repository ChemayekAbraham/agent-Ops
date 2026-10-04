#!/usr/bin/env node
/**
 * Build logger — captures every line of the publish/build pipeline to a .txt
 * file so failed production builds can be inspected after the fact.
 *
 * Usage:
 *   node scripts/build-logger.mjs [--fresh] [--stage <name>] -- <command...>
 *
 * The command is executed through the platform shell (so `&&` chains work),
 * its stdout/stderr are streamed to this process (nothing is hidden from the
 * publish console) AND appended to:
 *   build-logs/build.txt        <- latest run, stable path
 *   build-logs/build-<stamp>.txt<- one file per run (kept, last 10)
 *   dist/build-log.txt          <- copied at the end when dist/ exists
 *
 * On failure the tail of the log plus every line that looks like an error is
 * re-printed as a summary so the root cause is visible without opening files.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(projectRoot, 'build-logs');

const argv = process.argv.slice(2);
let fresh = false;
let stage = 'build';
const commandParts = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--fresh') fresh = true;
  else if (arg === '--stage') { stage = argv[i + 1] ?? stage; i += 1; }
  else if (arg === '--') commandParts.push(...argv.slice(i + 1)), (i = argv.length);
  else commandParts.push(arg);
}

const command = commandParts.join(' ');
if (!command) {
  console.error('[build-log] usage: node scripts/build-logger.mjs [--fresh] [--stage name] -- <command...>');
  process.exit(1);
}

mkdirSync(logDir, { recursive: true });

const stampFile = path.join(logDir, '.current');
const stamp = (() => {
  if (!fresh && existsSync(stampFile)) {
    try { return readFileSync(stampFile, 'utf8').trim() || null; } catch { /* ignore */ }
  }
  return null;
})() ?? new Date().toISOString().replace(/[:.]/g, '-');

try { createWriteStream(stampFile).end(stamp); } catch { /* ignore */ }

const runLog = path.join(logDir, `build-${stamp}.txt`);
const latestLog = path.join(logDir, 'build.txt');

// Keep only the 10 most recent run logs so the repo never accumulates junk.
try {
  const runs = readdirSync(logDir)
    .filter((f) => f.startsWith('build-') && f.endsWith('.txt'))
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - 10))) rmSync(path.join(logDir, old), { force: true });
} catch { /* ignore */ }

const mode = fresh ? 'w' : 'a';
const runStream = createWriteStream(runLog, { flags: mode });
const latestStream = createWriteStream(latestLog, { flags: mode });

const captured = [];
const startedAt = Date.now();

// Automated redaction: legacy domains must never land in a captured log file,
// because those files live in the scanned source tree (public/build-log.txt)
// and would trip scripts/guard-legacy-domain.mjs, aborting the next build.
// Console output is left untouched — only what we persist is redacted.
const LEGACY_DOMAIN_RE = /welilereceipts-com\.lovable\.app|welilereceipts?\.com|welilereciepts?\.com|welile-receipts\.com/gi;
export function redactLegacyDomains(text) {
  return String(text).replace(LEGACY_DOMAIN_RE, '[legacy-domain-redacted]');
}

function write(line) {
  const safe = redactLegacyDomains(line);
  captured.push(safe);
  runStream.write(safe);
  latestStream.write(safe);
}

write(
  `\n${'='.repeat(78)}\n[build-log] stage=${stage}\n[build-log] started=${new Date().toISOString()}\n` +
    `[build-log] node=${process.version} platform=${process.platform}\n[build-log] command=${command}\n${'='.repeat(78)}\n`,
);

const child = spawn(command, { shell: true, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });

function attach(streamName, source, sink) {
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    sink.write(chunk);
    const prefixed = chunk
      .split('\n')
      .map((line, index, all) => (index === all.length - 1 && line === '' ? '' : `${streamName === 'err' ? '[stderr] ' : ''}${line}`))
      .join('\n');
    write(prefixed);
  });
}

attach('out', child.stdout, process.stdout);
attach('err', child.stderr, process.stderr);

const ERROR_PATTERN = /(^|\s)(error|failed|failure|fatal|ENOENT|EACCES|OOM|SIGKILL|heap out of memory|Cannot find module|Could not resolve|Unexpected token)/i;

function finish(code, signal) {
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const text = captured.join('');
  const suspicious = text
    .split('\n')
    .filter((line) => line.trim() && ERROR_PATTERN.test(line))
    .slice(-40);

  write(
    `\n${'-'.repeat(78)}\n[build-log] stage=${stage} finished=${new Date().toISOString()} duration=${durationSec}s ` +
      `exit=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}\n` +
      `[build-log] suspicious lines: ${suspicious.length}\n` +
      (suspicious.length ? `${suspicious.map((l) => `  ! ${l.trim()}`).join('\n')}\n` : '') +
      `${'-'.repeat(78)}\n`,
  );

  // Ship the log with the build output so it is downloadable after publishing.
  // 1) dist/build-log.txt — present when this stage ran after vite build.
  const dist = path.join(projectRoot, 'dist');
  if (existsSync(dist)) {
    try { copyFileSync(latestLog, path.join(dist, 'build-log.txt')); } catch { /* ignore */ }
  }
  // 2) public/build-log.txt — committed to the repo, so Vite copies it into
  //    dist/ on the NEXT build. This is the reliable path: files written into
  //    dist/ after the bundler finishes are not always picked up by the
  //    deploy step, whereas public/ assets always are.
  const publicDir = path.join(projectRoot, 'public');
  if (existsSync(publicDir)) {
    try {
      // Belt-and-braces: log lines are already redacted at write() time, but
      // re-redact in case an older/partial log file is on disk.
      const sanitized = redactLegacyDomains(readFileSync(latestLog, 'utf8'));
      writeFileSync(path.join(publicDir, 'build-log.txt'), sanitized);
    } catch { /* ignore */ }
  }

  const failed = Boolean(signal) || (code ?? 1) !== 0;
  if (failed) {
    console.error(`\n[build-log] stage "${stage}" FAILED (exit=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}) after ${durationSec}s`);
    if (signal === 'SIGKILL') console.error('[build-log] SIGKILL usually means the container OOM-killed the build — lower BUILD_HEAP_MB.');
    if (suspicious.length) {
      console.error('[build-log] likely causes:');
      for (const line of suspicious.slice(-15)) console.error(`  ! ${line.trim()}`);
    }
    console.error(`[build-log] full log: ${path.relative(projectRoot, latestLog)} (and ${path.relative(projectRoot, runLog)})`);
  } else {
    console.log(`[build-log] stage "${stage}" ok in ${durationSec}s -> ${path.relative(projectRoot, latestLog)}`);
  }

  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(failed ? (code ?? 1) : 0); };
  runStream.end(done);
  latestStream.end(done);
}

child.on('error', (error) => {
  write(`[build-log] failed to start command: ${error.message}\n`);
  finish(1, null);
});
child.on('exit', (code, signal) => finish(code, signal));
