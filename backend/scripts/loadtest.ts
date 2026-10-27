/**
 * Minimal OPEN-MODEL (arrival-rate) smoke load generator used when k6 is unavailable.
 *   tsx scripts/loadtest.ts <url> <rps> <seconds>
 * Reports offered vs completed rate, errors and latency percentiles. A local smoke baseline only.
 */
const [url = 'http://127.0.0.1:4001/v1/products?limit=20', rpsArg = '200', secArg = '20'] =
  process.argv.slice(2);
const rps = Number(rpsArg),
  seconds = Number(secArg);
const lat: number[] = [];
let ok = 0,
  bad = 0,
  offered = 0,
  inflight = 0,
  maxInflight = 0;
const t0 = performance.now();
await new Promise<void>((done) => {
  const tick = setInterval(() => {
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed >= seconds) {
      clearInterval(tick);
      const wait = setInterval(() => {
        if (inflight === 0) {
          clearInterval(wait);
          done();
        }
      }, 50);
      return;
    }
    const due = Math.floor(elapsed * rps) - offered; // catch up if the timer lagged
    for (let i = 0; i < due; i++) {
      offered++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const s = performance.now();
      fetch(url)
        .then(async (r) => {
          await r.arrayBuffer();
          r.status === 200 ? ok++ : bad++;
        })
        .catch(() => bad++)
        .finally(() => {
          inflight--;
          lat.push(performance.now() - s);
        });
    }
  }, 5);
});
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]!.toFixed(1);
console.log(
  JSON.stringify(
    {
      url,
      targetRps: rps,
      seconds,
      offered,
      ok,
      failed: bad,
      achievedRps: +(ok / seconds).toFixed(1),
      maxInflight,
      p50ms: q(0.5),
      p95ms: q(0.95),
      p99ms: q(0.99),
    },
    null,
    1,
  ),
);
