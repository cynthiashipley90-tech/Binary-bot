// ---- Minimal test kit (plain Node, no runner dependency) ----
// test(name, fn) registers a test (fn may be async); run() executes them
// sequentially, prints one line per test, and sets a non-zero exit code if
// anything failed. Matches the "plain Node assert, no external test runner"
// approach the README describes.

const tests = [];
let finished = false;

// If the event loop drains while a test is still awaiting something (a
// never-settling promise), Node would exit 0 with tests silently skipped.
// Turn that into a loud failure.
process.on('exit', () => {
  if (!finished && tests.length) {
    console.log('  FAIL - test run did not complete: the process exited while a test was still pending');
    process.exitCode = 1;
  }
});

function test(name, fn) {
  tests.push({ name, fn });
}

async function run(suiteName) {
  let passed = 0;
  const failures = [];
  console.log(`\n# ${suiteName}`);
  for (const t of tests) {
    const started = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      await t.fn();
      passed += 1;
      console.log(`  ok   - ${t.name} (${Date.now() - started}ms)`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  FAIL - ${t.name}`);
      console.log(`         ${String(err && err.stack ? err.stack : err).split('\n').join('\n         ')}`);
    }
  }
  console.log(`  ${passed}/${tests.length} passed`);
  finished = true;
  if (failures.length) process.exitCode = 1;
  return { passed, failed: failures.length, total: tests.length };
}

module.exports = { test, run };
