// Runs every tests/*.test.js as its own child process (isolated module
// state - several suites monkeypatch shared singletons like the Redis
// wrapper), aggregates the results, and exits non-zero if any file failed.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failedFiles = 0;
let totalPassed = 0;
let totalTests = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL || 'silent' } });
  process.stdout.write(res.stdout || '');
  if (res.stderr && res.status !== 0) process.stderr.write(res.stderr);
  const m = /(\d+)\/(\d+) passed/.exec(res.stdout || '');
  if (m) { totalPassed += Number(m[1]); totalTests += Number(m[2]); }
  if (res.status !== 0 || !m) {
    if (!m) console.log(`  FAIL - ${file} produced no result summary`);
    failedFiles += 1;
  }
}

console.log(`\n==== ${files.length} file(s), ${totalPassed}/${totalTests} tests passed, ${failedFiles} file(s) with failures ====`);
process.exit(failedFiles ? 1 : 0);
