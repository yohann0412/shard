const path = require('path');
const fs = require('fs');
const entry = process.argv[1] || '';
if (entry.endsWith(path.join('lib', 'common', 'process.js'))) {
  const wm = require(path.join(path.dirname(entry), '..', 'worker', 'workerMain.js'));
  const orig = wm.WorkerMain.prototype._runTest;
  wm.WorkerMain.prototype._runTest = async function (test, retry, nextTest) {
    fs.appendFileSync('hooks.log', `begin ${test.title} pid=${process.pid} pi=${process.env.TEST_PARALLEL_INDEX}\n`);
    try { return await orig.call(this, test, retry, nextTest); }
    finally { fs.appendFileSync('hooks.log', `end ${test.title} pid=${process.pid}\n`); }
  };
  console.error(`[preload] patched WorkerMain in pid=${process.pid} TEST_PARALLEL_INDEX at preload time=${process.env.TEST_PARALLEL_INDEX}`);
}
