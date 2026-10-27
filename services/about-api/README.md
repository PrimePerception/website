# About page API

An independent Cloudflare Worker with D1 storage. The Astro website remains static on GitHub Pages. Public reads never contact Runpod; a minute cron collects the approved aggregate independently of visits.

## Local preview

Use Node 22.22.3 or newer. From this directory:

```sh
npm ci
npm run local:setup
npm run dev
```

Start the Astro site from the repository root in another terminal:

```sh
PUBLIC_ABOUT_API_BASE=http://127.0.0.1:8787 npm run dev
```

Visit `http://localhost:4321/about`. Local setup applies **only local** migrations and seeds two days of synthetic, sanitized GPU percentages, explicit chart gaps, and demonstration reaction counters. These local readings and totals are fixtures, not live production activity. Rerun `local:setup` to refresh samples after three minutes; otherwise the status becomes Unavailable. Local tokens are signed for the `local` environment and cannot be used in production. Fixture requests are rejected unless the API hostname is loopback; local crons never collect or activate production tracking. Local storage is isolated under ignored `.wrangler/`.

## Production activation

The committed production configuration is deliberately incomplete. No production database, key, counters, or history has been created by this change.

1. Authenticate with the intended Cloudflare account using `npx wrangler login`.
2. Create the dedicated database with `npx wrangler d1 create prime-about`. Put the returned database ID into `wrangler.jsonc` in this directory. Keep `ENVIRONMENT=production`, `FIXTURES_ENABLED=false`, and the production origin allowlist. `npm run deploy` rejects the placeholder and local database IDs.
3. Apply `npm run migrate` to the dedicated production D1 database. Migrations initialize genuine reaction totals at zero and preserve tracking metadata on later deployments. Never import the local fixture SQL into production.
4. Enter a dedicated **read-only** Runpod API key directly into Worker secrets, using the interactive secret prompt. Create two different cryptographically random secrets of at least 32 characters for visitor signatures and rotating IP hashes, also through interactive secret prompts:

   ```sh
   npx wrangler secret put RUNPOD_API_KEY
   npx wrangler secret put VISITOR_SIGNING_SECRET
   npx wrangler secret put IP_HASH_SECRET
   ```

   Keep the visitor-signing secret stable across deployments so existing anonymous visitors retain their limits. Secrets belong only in the Worker secret store. Do not put them in the Astro environment, repository, shell command arguments, fixtures, logs, or browser.

5. Run the checks below and `npm run deploy`. The Worker config enables minute collection (`* * * * *`) and a daily conference-source check (`17 8 * * *`, UTC). Cron scheduling is approximate; missing executions naturally become history gaps and eventually stale status.
6. Set the GitHub Pages build variable `PUBLIC_ABOUT_API_BASE` to the deployed HTTPS Worker URL (or an API custom domain). It is a public URL, with no credential or query string. Rebuild the static website.
7. Verify the public status DTO and safe failure behavior. Tracking activates with the first complete, valid production sample, including a genuinely confirmed 0%. Its timestamp is retained separately from minute history and survives pruning and deployments.

If the API is not configured, the website shows its unavailable/not-started state. It never substitutes fabricated production history or reaction totals. Do not activate this service with an unrestricted Runpod key.

## Public endpoints

| Route                                          | Result                                                                             | Cache                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `GET /v1/workbench/status`                     | Only `utilizationPercent`, `status`, `stale`, `lastUpdatedAt`, `trackingStartedAt` | Up to 30 seconds, shortened at the stale boundary |
| `GET /v1/workbench/history?range=24h\|7d\|30d` | Timestamp/null-or-percentage buckets, range and tracking start                     | 5 minutes                                         |
| `GET /v1/reactions`                            | Shared `counts`                                                                    | 15 seconds                                        |
| `POST /v1/reactions/session`                   | Signed anonymous `token`, `expiresAt`                                              | No store                                          |
| `POST /v1/reactions`                           | Atomic receipt and current shared counts                                           | No store                                          |
| `GET /v1/conferences`                          | Normalized public conference records                                               | 5 minutes                                         |

POSTs require `Content-Type: application/json` and an exact allowlisted Origin. Session creation takes `{}`. Reaction requests take exactly `{ "kind": "gg", "requestId": "<UUID>" }` and `Authorization: Bearer <token>`. Kinds are `gg`, `touch-grass`, `shower`, `league`. The browser stores the signed token locally, reuses the same request UUID for network retries, and uses the server's cooldown information. No cookies or account are needed. An existing request UUID for the same visitor/kind returns a duplicate success without incrementing. Reusing it for another kind is rejected.

The database enforces 60 seconds between reactions and 20 reactions per UTC day **for each kind and visitor**. The conditional event insert and counter trigger run in one SQLite statement; the receipt reads share a D1 batch transaction. Limits apply across browsers using the same token, Workers and Cloudflare locations. Anonymous event IDs provide a **48-hour idempotency window**; only random visitor HMACs, request UUIDs, kind, and event timestamps are stored. Independent cron cleanup deletes older events even if provider collection or conference parsing fails. This keeps current UTC-day limits and cross-midnight cooldowns intact. A request retried after its event has expired may count again; clients should retry a pending click promptly. Shared counters persist indefinitely and cleanup never decrements them.

Native Cloudflare limiters additionally apply approximate coarse per-IP limits: 180 public requests/minute and 30 write/session requests/minute, per location. They receive daily rotating HMAC values, never raw addresses; IP data is not stored in D1 or application logs. These limits supplement the authoritative D1 visitor rules. Clearing local storage can create a new visitor, so anonymous reactions are intentionally a lightweight encouragement feature, not voting or identity verification. See [Cloudflare's rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Workbench data boundary

`src/runpod.ts` is the only provider adapter. It requests only pod desired state, GPU count, GPU utilization readings, and telemetry state/time for completeness validation. Neither those private fields nor provider response/error objects leave the adapter. The only return is a finite aggregate percentage or `null`.

- Every running GPU contributes equally; pod averages are not averaged together. The result is rounded to one decimal place. Active is at least 5%; lower valid readings are Idle.
- All running GPU devices must have finite percentages from 0–100, matching the expected GPU count, and fresh RUNNING telemetry (no older than three minutes, no more than one minute in the future). Missing runtime, devices or timestamps, partial GraphQL errors, unknown states, malformed responses, timeout and authentication failure yield `null`/Unavailable. An empty successful pod list or definite stopped pods permits Idle/0%. A stopped target must have no remaining runtime and either no telemetry or valid fresh stopped telemetry; contradictory RUNNING telemetry, transition states, stale/partial telemetry or a remaining runtime yields Unavailable rather than a false zero.
- The fixed HTTPS provider endpoint uses a Bearer header, no redirects, an eight-second abort and a 1 MiB response bound. Raw responses, credentials, hardware/workload identifiers, provider errors and names are never persisted or logged.
- D1 stores just the minute timestamp, collection timestamp and nullable aggregate percentage, plus activation/last-success/last-attempt timestamps. An atomic collection-order guard prevents delayed overlapping executions from overwriting a newer reading within the same minute; metadata and pruning cutoffs cannot move backwards. Failed attempts create null gaps while preserving the last successful update. The public status becomes stale three minutes after the last valid sample; failures report Unavailable immediately, even before the stale threshold.
- Minute aggregates are pruned after 30 days. Chart responses contain at most 289/169/241 points for 24h/7d/30d, using 5-minute/1-hour/3-hour buckets. A missing or invalid expected minute makes the bucket null. The activation minute can be a partial first bucket; its displayed timestamp never predates activation. Future portions of the current bucket are not treated as missing samples.
- Cache entries contain only approved DTOs. Keys retain the API request's origin and normalize the route/range, so separate deployment hosts cannot share cached responses. CORS is added after cache lookup, so one request's Origin cannot poison the shared payload. Personalized, write and error responses are always `no-store`. Application observability is disabled; do not add payload or exception logging.

## Required provider migration before January 2027

Runpod announced that GraphQL stops operating in **January 2027**, with rate limits starting October 27, 2026: [official migration notice](https://www.runpod.io/blog/runpod-q3-2026-releases). This launch intentionally isolates the known GraphQL telemetry adapter. Before retirement, replace `src/runpod.ts` with Runpod's supported telemetry API once its completeness and freshness contract is validated, keep the same aggregate-only return type, rerun privacy/telemetry tests, and deploy. Request only the replacement fields needed for the same validation. Do not replace this with a broad pod-details endpoint or relax completeness checks to keep the widget looking active. If the old API stops working first, the service remains Unavailable and history contains gaps.

## Conference maintenance

The conference module owns official-source allowlisting, conference-specific parsing, cycle normalization and public DTO construction. The daily cron accepts only unambiguous matching-cycle main-paper deadlines, with a stated time zone. Ambiguous/conflicting/failing checks retain the last verified record, mark it for review, and expose verification freshness. Estimates retain month/window precision and never acquire a fabricated exact date/countdown. Inspect `needsReview`, `checkedAt`, and `verifiedAt` when maintaining the records; links in each record identify the official source.

## Checks

```sh
npm run check
npm test
npm run build
```

Tests execute the actual SQL with Node's SQLite engine, including concurrent independent connections, duplicate retries, cooldown/day boundaries, caps and rollback. Workbench tests cover device-weighted aggregation, true zeros, partial/stale/invalid telemetry, outages, history gaps, retention and persistent activation. HTTP tests audit DTO fields, safe errors, provider-independent reads, origins, tokens, rate limits and fixture guards. Conference tests cover source parsing, cycles, sorting, estimated windows, registration and published time zones. `npm run build` is a Worker bundle dry run; root Astro build/check and browser accessibility/theme/mobile verification are separate repository checks.

Useful primary references: [D1 transactions/batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Runpod GraphQL schema](https://graphql-spec.runpod.io/).
