const urls = (process.env.ISOLATE_WORKER_URLS ?? '').split(',');
const idx = process.env.TEST_PARALLEL_INDEX;
if (idx !== undefined) process.env.BASE_URL = urls[Number(idx)];
console.error(`[isolate-env] pid=${process.pid} TEST_PARALLEL_INDEX=${idx} -> BASE_URL=${process.env.BASE_URL}`);
