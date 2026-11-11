// usage: node body.js <file> <fnname> [outfile]
// Prints md5/length of the LAST "create or replace function <fn>(" body in <file>.
const fs = require('fs'), crypto = require('crypto');
const [, , file, fn, out] = process.argv;
let t = fs.readFileSync(file, 'utf8');
const re = new RegExp('create\\s+or\\s+replace\\s+function\\s+(public\\.)?' + fn + '\\s*\\(', 'gi');
let m, last = null;
while ((m = re.exec(t))) last = m.index;
if (last === null) { console.log(file, 'none'); process.exit(); }
const rest = t.slice(last);
const q = rest.match(/AS\s+(\$[a-z_]*\$)/i);
const tag = q[1];
const start = rest.indexOf(tag, q.index) + tag.length;
const end = rest.indexOf(tag, start);
const body = rest.slice(start, end);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
console.log(file, md5(body), body.length, 'lf-normalised:', md5(body.replace(/\r\n/g, '\n')));
if (out) fs.writeFileSync(out, body.replace(/\r\n/g, '\n'));
