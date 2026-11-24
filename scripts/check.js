'use strict';

// npm run check — soi cú pháp toàn bộ file trước khi chạy.
const { readdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = [];
for (const dir of ['src', 'scripts']) {
  for (const f of readdirSync(path.join(root, dir))) {
    if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
}

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    console.log('OK   ' + f);
  } catch (err) {
    bad += 1;
    console.error('FAIL ' + f);
    console.error(err.stderr ? err.stderr.toString() : err.message);
  }
}
console.log(bad ? `\n${bad} file lỗi cú pháp` : '\nSYNTAX OK');
process.exit(bad ? 1 : 0);
