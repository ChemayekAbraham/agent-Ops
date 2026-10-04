#!/usr/bin/env node
/**
 * Run a build-pipeline step that must NEVER fail the deploy.
 *
 * The sitemap generator (prebuild) and the house prerenderer (postbuild) are
 * SEO/metadata enrichment steps. They depend on the network and on dev-only
 * tooling (`tsx`), neither of which is guaranteed inside the publish build
 * container. If either exits non-zero — or is OOM-killed by a signal — npm
 * aborts the whole publish with an opaque "Publishing failed because of an
 * error in your app". The app itself is perfectly buildable in that case.
 *
 * So: run the step, surface its output, and always exit 0.
 *
 * Usage: node scripts/run-optional.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.warn('[optional] usage: node scripts/run-optional.mjs <command> [args...]');
  process.exit(0);
}

const label = [command, ...args].join(' ');
const child = spawn(command, args, { stdio: 'inherit', shell: false });

child.on('error', (error) => {
  console.warn(`[optional] "${label}" could not start (${error.message}) — continuing build.`);
  process.exit(0);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.warn(`[optional] "${label}" terminated by signal ${signal} — continuing build.`);
  } else if (code !== 0) {
    console.warn(`[optional] "${label}" exited with code ${code} — continuing build.`);
  }
  process.exit(0);
});