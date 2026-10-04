#!/usr/bin/env node
/**
 * Publish diagnostics report.
 *
 * Records, in one artifact: (1) the publish request ID for this attempt,
 * (2) the deterministic build artifact hash of dist/, and (3) the
 * hosting-stage HTTP responses (canonical origin + the previously deployed
 * copy of this report). Comparing the local artifact hash with the hash
 * served live pinpoints whether the hosting/CDN stage actually received the
 * build, which is invisible when the root URL happily serves 200.
 *
 * Outputs: build-logs/publish-diagnostics.txt, build-logs/publish-diagnostics.json,
 * dist/publish-diagnostics.json (ships so it can be fetched live).
 *
 * Never fails the build unless --strict is passed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CANONICAL_ORIGIN } from './site-domains.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(repoRoot, 'dist');
const logDir = path.resolve(repoRoot, 'build-logs');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
// Probes are opt-in: during a real publish the hosting stage may have no egress
// (or the origin can hang), and a diagnostics fetch must never risk the deploy.
const skipProbe =
  argv.includes('--no-probe') ||
  process.env.PUBLISH_DIAGNOSTICS_PROBE === '0' ||
  !(argv.includes('--probe') || process.env.PUBLISH_DIAGNOSTICS_PROBE === '1');
const PROBE_TIMEOUT_MS = Number(process.env.PUBLISH_DIAGNOSTICS_TIMEOUT_MS || 12000);

function publishRequestId() {
  const provided =
    process.env.LOVABLE_PUBLISH_ID ||
    process.env.LOVABLE_DEPLOY_ID ||
    process.env.LOVABLE_REQUEST_ID ||
    process.env.DEPLOYMENT_ID ||
    process.env.GITHUB_RUN_ID;
  if (provided) return { id: String(provided).trim(), source: 'environment' };
  return { id: `local-${randomUUID()}`, source: 'generated (no platform publish ID in env)' };
}

function gitInfo() {
  const read = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  return { commit: read(['rev-parse', 'HEAD']), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

function collectFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) collectFiles(full, base, out);
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: stats.size, full });
  }
  return out;
}

// Files that carry the diagnostics themselves are excluded from the artifact
// hash so the hash stays a pure function of the built application output.
function isDiagnosticFile(rel) {
  return rel === 'publish-diagnostics.json' || rel.startsWith('_deploy/');
}

function artifactFingerprint() {
  if (!existsSync(dist)) return { present: false, files: 0, bytes: 0, hash: null, entryHtmlHash: null };
  const files = collectFiles(dist).filter((f) => !isDiagnosticFile(f.rel));
  const manifest = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const fileHash = createHash('sha256').update(readFileSync(file.full)).digest('hex');
    manifest.update(`${file.rel}:${fileHash}\n`);
    bytes += file.size;
  }
  const indexPath = path.join(dist, 'index.html');
  return {
    present: true,
    files: files.length,
    bytes,
    hash: manifest.digest('hex'),
    entryHtmlHash: existsSync(indexPath)
      ? createHash('sha256').update(readFileSync(indexPath)).digest('hex')
      : null,
  };
}

const INTERESTING_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'age',
  'etag',
  'last-modified',
  'x-cache',
  'x-served-by',
  'cf-ray',
  'server',
];

async function probe(label, url, { json = false } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: controller.signal,
    });
    const body = await res.text();
    const headers = {};
    for (const name of INTERESTING_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers[name] = value;
    }
    let parsed = null;
    if (json) {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
    }
    return {
      label,
      url,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url,
      redirected: res.redirected,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(body),
      headers,
      json: parsed,
      text: body.length <= 512 ? body : `${body.slice(0, 512)}…`,
      servedHtml: /text\/html/i.test(res.headers.get('content-type') || '') || /^\s*<!DOCTYPE html/i.test(body),
    };
  } catch (error) {
    return {
      label,
      url,
      ok: false,
      status: 0,
      statusText:
        error?.name === 'AbortError'
          ? `timeout after ${PROBE_TIMEOUT_MS}ms`
          : String(error?.message || error),
      ms: Date.now() - started,
      headers: {},
      json: null,
      text: null,
      servedHtml: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dedicated non-fallback diagnostic endpoints.
 *
 * Every path below lives under /_deploy/ and ends in a file extension, so the
 * hosting layer treats it as an asset request and never rewrites it to
 * index.html. That makes both failure modes visible instead of masked:
 *   - missing artifact  -> a real 404 (not a 200 HTML shell)
 *   - stale artifact    -> hash text that differs from the local build
 *
 * artifact-hash.txt is intentionally a bare hash so it can be diffed with a
 * one-line curl, and manifest.json carries the full publish context.
 */
function emitDeployProbes(report) {
  if (!report.artifact.present) return [];
  const dir = path.join(dist, '_deploy');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    publishRequestId: report.publishRequestId,
    publishRequestIdSource: report.publishRequestIdSource,
    generatedAt: report.generatedAt,
    git: report.git,
    artifact: report.artifact,
    note: 'Static non-fallback deploy probe. Compare artifact.hash with the locally built hash to prove whether hosting received this build.',
  };
  const written = [
    ['artifact-hash.txt', `${report.artifact.hash}\n`],
    ['publish-id.txt', `${report.publishRequestId}\n`],
    ['index-html-hash.txt', `${report.artifact.entryHtmlHash}\n`],
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    [
      'probe.txt',
      [
        'welile deploy probe',
        `publish-id=${report.publishRequestId}`,
        `artifact-hash=${report.artifact.hash}`,
        `generated-at=${report.generatedAt}`,
        `commit=${report.git.commit || 'unknown'}`,
        '',
      ].join('\n'),
    ],
  ];
  for (const [name, body] of written) writeFileSync(path.join(dir, name), body, 'utf8');
  return written.map(([name]) => `_deploy/${name}`);
}

function verdict(report) {
  if (report.probesSkipped) return 'hosting probes skipped — local artifact fingerprint recorded only';
  const root = report.hosting.find((p) => p.label === 'canonical origin');
  const live = report.hosting.find((p) => p.label === 'deployed artifact hash (static, no fallback)');
  const control = report.hosting.find((p) => p.label === 'negative control (must be 404)');
  if (!root?.ok) {
    return `HOSTING STAGE UNREACHABLE — canonical origin returned ${root?.status || 0} (${root?.statusText})`;
  }
  if (control && control.status !== 404) {
    return `SPA FALLBACK IS MASKING MISSING FILES — a guaranteed-nonexistent static path returned ${control.status} (${control.headers['content-type'] || 'unknown type'}); every 404 on this host is unreliable, so version checks must use the /_deploy/ endpoints and compare hashes, never status codes`;
  }
  if (!live?.ok || !live.text) {
    return 'ROOT SERVES 200 BUT NO DEPLOYED DIAGNOSTICS REPORT — either the last publish never uploaded this artifact (deploy stage failed after a green build) or this is the first build carrying the report';
  }
  if (live.text.trim() === report.artifact.hash) {
    return 'LIVE ARTIFACT MATCHES LOCAL BUILD — hosting stage received and is serving this exact build';
  }
  return `LIVE ARTIFACT IS STALE — live hash ${live.text.trim().slice(0, 16)}… != this build ${String(report.artifact.hash).slice(0, 16)}…; the upload/CDN stage, not the build, is dropping the new artifact`;
}

function renderText(report) {
  const lines = [];
  const rule = '='.repeat(72);
  lines.push(rule, 'PUBLISH DIAGNOSTICS REPORT', rule);
  lines.push(`generated at        : ${report.generatedAt}`);
  lines.push(`publish request ID  : ${report.publishRequestId}  (${report.publishRequestIdSource})`);
  lines.push(`git commit / branch : ${report.git.commit || 'unknown'} / ${report.git.branch || 'unknown'}`);
  lines.push(`node / platform     : ${report.runtime.node} on ${report.runtime.platform}`);
  lines.push('');
  lines.push('-- BUILD ARTIFACT ------------------------------------------------------');
  lines.push(`dist present        : ${report.artifact.present}`);
  lines.push(`artifact hash       : ${report.artifact.hash || 'n/a'}`);
  lines.push(`index.html hash     : ${report.artifact.entryHtmlHash || 'n/a'}`);
  lines.push(`files / bytes       : ${report.artifact.files} files / ${report.artifact.bytes} bytes`);
  lines.push(`non-fallback probes : ${report.deployProbeFiles.join(', ') || 'none (no dist)'}`);
  lines.push('');
  lines.push('-- HOSTING STAGE RESPONSES --------------------------------------------');
  if (report.probesSkipped) {
    lines.push('(probes skipped)');
  } else {
    for (const p of report.hosting) {
      lines.push(`[${p.status || 'ERR'}] ${p.label}`);
      lines.push(`      url        : ${p.url}`);
      if (p.finalUrl && p.finalUrl !== p.url) lines.push(`      final url  : ${p.finalUrl}`);
      lines.push(`      result     : ${p.ok ? 'ok' : 'FAILED'} ${p.statusText || ''} in ${p.ms}ms`);
      for (const [k, v] of Object.entries(p.headers)) lines.push(`      ${k.padEnd(11)}: ${v}`);
      if (p.servedHtml && !p.url.includes('?publish-diagnostics=')) {
        lines.push('      WARNING    : HTML returned for a static asset path — SPA fallback is masking this response');
      }
      if (p.text && p.text.length <= 96 && !p.servedHtml) lines.push(`      body       : ${p.text.trim()}`);
      if (p.json?.artifact?.hash) lines.push(`      live hash  : ${p.json.artifact.hash}`);
      if (p.json?.publishRequestId) lines.push(`      live pubID : ${p.json.publishRequestId}`);
      lines.push('');
    }
  }
  lines.push('-- VERDICT ------------------------------------------------------------');
  lines.push(report.verdict);
  lines.push(rule);
  return lines.join('\n');
}

async function main() {
  const { id, source } = publishRequestId();
  const report = {
    generatedAt: new Date().toISOString(),
    publishRequestId: id,
    publishRequestIdSource: source,
    git: gitInfo(),
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
    artifact: artifactFingerprint(),
    probesSkipped: skipProbe,
    deployProbeFiles: [],
    hosting: [],
    verdict: '',
  };
  report.deployProbeFiles = emitDeployProbes(report);

  if (!skipProbe) {
    report.hosting = [
      await probe('canonical origin', `${CANONICAL_ORIGIN}/?publish-diagnostics=${encodeURIComponent(id)}`),
      await probe('deployed artifact hash (static, no fallback)', `${CANONICAL_ORIGIN}/_deploy/artifact-hash.txt`),
      await probe('deployed publish ID (static, no fallback)', `${CANONICAL_ORIGIN}/_deploy/publish-id.txt`),
      await probe('deployed manifest (static, no fallback)', `${CANONICAL_ORIGIN}/_deploy/manifest.json`, { json: true }),
      await probe('negative control (must be 404)', `${CANONICAL_ORIGIN}/_deploy/missing-${id}.txt`),
      await probe('deployed diagnostics report', `${CANONICAL_ORIGIN}/publish-diagnostics.json`, { json: true }),
      await probe('deployed build log', `${CANONICAL_ORIGIN}/build-log.txt`),
      await probe('sitemap', `${CANONICAL_ORIGIN}/sitemap.xml`),
    ];
  }
  report.verdict = verdict(report);

  mkdirSync(logDir, { recursive: true });
  const text = renderText(report);
  writeFileSync(path.join(logDir, 'publish-diagnostics.txt'), `${text}\n`, 'utf8');
  writeFileSync(path.join(logDir, 'publish-diagnostics.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.artifact.present) {
    writeFileSync(path.join(dist, 'publish-diagnostics.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(text);
}

main().catch((error) => {
  console.warn(`[publish-diagnostics] non-fatal failure: ${error?.message || error}`);
  if (strict) process.exitCode = 1;
});