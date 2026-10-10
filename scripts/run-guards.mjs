#!/usr/bin/env node
/**
 * Guard runner with fail-fast, verbose messaging.
 *
 * Runs every pre-build guard in order. Each guard's stdout/stderr is streamed
 * AND buffered, so when one fails we print a single unambiguous block naming
 * the exact guard, its command, its exit code/signal and its full output. That
 * makes "Publishing failed because of an error in your app" traceable to one
 * command in the workflow / build log instead of a silent abort.
 *
 * Exit code mirrors the first failing guard (1 when killed by a signal).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const GUARDS = [
  ['check-runtime-env.mjs', 'required build environment'],
  ['guard-schema-types.mjs', 'generated schema types fingerprint'],
  ['guard-frontend-ledger-writes.mjs', 'frontend ledger writes'],
  ['guard-deposit-purpose.mjs', 'deposit purpose'],
  ['guard-legacy-domain.mjs', 'legacy domain references'],
  ['guard-location-freetext.mjs', 'free-text admin location capture'],
  ['guard-canonical-tags.mjs', 'canonical tags'],
  ['guard-privileged-function-grants.mjs', 'privileged function EXECUTE grants'],
  ['guard-tops-client-math.mjs', 'tenant ops workspace client-side money math'],
  ['guard-assistant-readonly.mjs', 'agent assistant is read-only and user-scoped'],
];

const bar = '='.repeat(78);
console.log(`[guards] running ${GUARDS.length} pre-build guards (node=${process.version} platform=${process.platform})`);

for (const [file, label] of GUARDS) {
  const entry = path.resolve(scriptDir, file);
  const started = Date.now();
  console.log(`[guards] -> ${label} (${file})`);
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();

  if (result.error) {
    console.error(`\n${bar}\n[guards] BLOCKED: ${label}\n[guards] guard could not start: ${result.error.message}\n[guards] command: ${process.execPath} ${entry}\n${bar}\n`);
    process.exit(1);
  }

  const failed = Boolean(result.signal) || result.status !== 0;
  if (failed) {
    console.error(`\n${bar}`);
    console.error(`[guards] BLOCKED: ${label}`);
    console.error(`[guards] guard:   scripts/${file}`);
    console.error(`[guards] command: node scripts/${file}`);
    console.error(`[guards] exit:    ${result.status ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''} after ${seconds}s`);
    console.error(`[guards] reason:  this guard blocks the build; fix the violations below, then republish.`);
    console.error(`${'-'.repeat(78)}`);
    console.error(output || '(guard produced no output)');
    console.error(`${bar}\n`);
    process.exit(result.signal ? 1 : (result.status ?? 1));
  }

  if (output) console.log(output);
  console.log(`[guards] ok ${label} (${seconds}s)`);
}

console.log('[guards] all guards passed');
