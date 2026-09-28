# Review: shared-origin mode (header-routed proxy, D-014)

Subagent report: a proxy process on the build-time origin routes each request to app i by the `x-isolate-worker` header (HTTP and WebSocket upgrades), refuses unlabelled requests with 421, counts requests per (worker, app), and feeds those counts into the routing verdict; plus two bug fixes from the rallly onboarding (reruns get their own `--output`, and an interrupted run's routing is "unknown", not "valid"). It passed f4, f6, f7 and a new f8 test on the fixture before the machine lock; its rallly arms were not run (the lead runs them).

## What could be wrong

- **The header rides on third-party requests too.** `extraHTTPHeaders` applies to every request the page makes, so cross-origin fetches/XHRs from the page carry `x-isolate-worker` and trigger CORS preflights that third parties may reject. Not exercised here (no fixture or rallly test talks to a third party in the subsets run).
- **Server-side self-calls carry no header.** An app that fetches its own public origin from Node (SSR calling its own API through `NEXT_PUBLIC_BASE_URL`) reaches the proxy without the header and gets 421. That shows up as refused requests in the report and as test failures; it is a real limit of the approach.
- **The routing check got weaker in one case**: in shared-origin mode, one app ignoring its database URL while the others use theirs passes as valid with a warning (D-014 records it). The proxy's per-app counts are a stronger check than before for "did worker i talk to app i", but database routing now leans on the warning.
- **Deleting `.isolate/` under a live run disables SIGKILL cleanup** (the reaper treats a missing state file as a clean shutdown). Pre-existing; the subagent hit it in its own test and fixed the test, not the tool. Recorded as a known limit.
- **Node's `fetch` retries a 421 once**, so `refused` counts attempts, not requests.

## What was not tested

- IPv6 `::1` (no IPv6 in this sandbox), a real browser WebSocket through the proxy, `trace --shared-origin`, CORS against real third parties, `app up` with a shared origin.
- The final edit of the f8 test (it compiles; the lead runs it after integration).

## What was assumed

- That a single origin is enough: apps with several public origins (an API on another port) need one proxy per origin, which is not implemented.
