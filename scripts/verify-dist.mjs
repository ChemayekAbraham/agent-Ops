#!/usr/bin/env node
/** Final publish-artifact preflight: validates exactly what hosting uploads. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(repoRoot, 'dist');
const MAX_FILES = 45_000;
const MAX_BYTES = 2.5 * 1024 ** 3;
const MAX_HOUSE_SHELLS = 5_000;
const errors = [];

function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      const child = walk(full);
      files += child.files;
      bytes += child.bytes;
    } else {
      files += 1;
      bytes += stats.size;
    }
  }
  return { files, bytes };
}

if (!existsSync(path.join(dist, 'index.html'))) {
  errors.push('dist/index.html is missing');
}

let artifact = { files: 0, bytes: 0 };
if (existsSync(dist)) artifact = walk(dist);
if (artifact.files >= MAX_FILES) errors.push(`dist has ${artifact.files} files (limit ${MAX_FILES})`);
if (artifact.bytes >= MAX_BYTES) errors.push(`dist is ${artifact.bytes} bytes (limit ${MAX_BYTES})`);

const houseDir = path.join(dist, 'house');
const houseShells = existsSync(houseDir)
  ? readdirSync(houseDir).filter((entry) => existsSync(path.join(houseDir, entry, 'index.html'))).length
  : 0;
if (houseShells > MAX_HOUSE_SHELLS) errors.push(`dist contains ${houseShells} house shells (limit ${MAX_HOUSE_SHELLS})`);

for (const name of ['sitemap.xml', 'sitemap-welilereceipts.xml']) {
  const file = path.join(dist, name);
  if (!existsSync(file)) {
    errors.push(`dist/${name} is missing`);
    continue;
  }
  const xml = readFileSync(file, 'utf8');
  const urls = (xml.match(/<url>/g) || []).length;
  const closes = (xml.match(/<\/url>/g) || []).length;
  if (!xml.startsWith('<?xml') || !xml.includes('<urlset ') || !xml.trimEnd().endsWith('</urlset>')) {
    errors.push(`dist/${name} is not a complete sitemap document`);
  }
  if (urls !== closes || urls === 0 || urls > 50_000) {
    errors.push(`dist/${name} has an invalid URL count (${urls} open, ${closes} close)`);
  }
}

if (errors.length) {
  console.error('\n❌ Final dist preflight BLOCKED publish.');
  for (const error of errors) console.error(`  • ${error}`);
  process.exit(1);
}

console.log(
  `[dist-preflight] verified upload artifact: ${artifact.files} files, ` +
    `${(artifact.bytes / 1024 ** 2).toFixed(1)} MiB, ${houseShells} house shells, valid sitemaps`,
);