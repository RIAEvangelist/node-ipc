# IPC benchmark

![Four node-ipc performance profiles: raw race motorcycle, fast race car, guarded soccer-parent minivan, and assured olive-drab military vehicle](../assets/node-ipc-performance-tiers.png)

The vehicles define planned configuration profiles: **Raw**, **Fast**, **Guarded**, and **Assured**. Legacy remains a compatibility lane, not a performance tier. The profiles will describe measured overhead and intended risk posture after their adapters land; they are not government or military certifications.

The benchmark contract has three lanes. Results never cross lanes. The current harness establishes the raw-client lane with a `node:net` baseline; parser and end-to-end adapters land with their implementations.

1. **Parser** measures encode, chunk, and decode work in one process.
2. **Raw client** connects each compatible client to the same byte reflector.
3. **End to end** runs each system's native client and server contract.

The raw service reflects bytes without parsing them. "Shared" means the same source and protocol, not one long-lived process: every sample gets a new oracle, worker, connection, port, and temporary directory.

The raw lane accounts for exact byte totals. Framed parser and end-to-end adapters must additionally verify message sequence and payload content.

## Published run

- deterministic 64-byte payload;
- 100,000 warm-up messages;
- three forced GCs after warm-up, outside timing;
- 1,000,000 completed messages per pass;
- seven fresh samples per adapter and pass;
- a paired `node:net` baseline in every round, with adapter order reversed between rounds;
- milliseconds per million messages and the delta from that paired baseline;
- speed, resource, and latency passes run separately;
- every raw sample is retained; no outlier is deleted.

The speed pass uses only boundary timing and CPU counters. The resource pass adds memory sampling, GC observation, and event-loop delay. The latency pass keeps one message in flight and records p50, p95, and p99. Instrumented results are not presented as speed results.

Published raw-client comparisons use the standard-C reflector:

```sh
node benchmark/oracle/build.js
npm run benchmark
```

The compiler-free Node reflector is for development and CI smoke runs. Its results are labelled separately and are never mixed with C-oracle results.

```sh
npm run benchmark:quick
npm run benchmark:test
```

## Tracked evidence

Every accepted run is written as versioned, sanitized raw JSON under `benchmark/results/` and indexed by `benchmark/results/index.json`. Git state is captured before and after execution. Each append-only run ID has a manifest SHA-256. The record retains a privacy-preserving machine fingerprint and specifications, OS, architecture, Node version, Git commit and clean-state proof, oracle source and binary hashes, fixed compiler flags and target, the canonical configuration, every performance sample, cleanup proof, memory checkpoints, GC observations, and package footprint. It excludes usernames, absolute temporary paths, ephemeral ports, and process IDs.

Run a fast development check without recording it:

```sh
npm run benchmark:quick
```

Quick and custom runs write ephemeral JSON to standard output only. The recorder rejects dirty trees, changed trees, non-C oracles, custom/tiny configurations, failed cleanup or count gates, saturated oracles, unverifiable builds, and missing package-footprint evidence before it writes anything under `benchmark/results/`.

For publishable evidence, start from a clean commit on an identified idle machine, build the C oracle, and run the complete configuration:

```sh
npm run benchmark:record
npm run benchmark:validate
```

The recorder uses exactly three passes with seven samples per pass, a 64-byte payload, 100,000 warm-up messages, and 1,000,000 measured messages per pass. The validator applies the public schema, recomputes sample and cleanup counts, verifies current and historical manifest hashes, and enforces append-only history. Hosted figures are explicitly `snapshot-noisy`, not authoritative rankings. An empty manifest is valid before the first verified baseline; rankings remain disabled until comparable clean C-oracle node-ipc adapters exist.

### Official snapshots

Run the manual **Record benchmark snapshots** workflow from a clean `main` commit. It records the same C-oracle baseline on Ubuntu, macOS, and Windows with Node 22.12.0 and 24.18.1. The workflow has read-only repository permissions and uploads sanitized JSON for review; it never commits results.

After every matrix job passes, download the six artifacts outside the repository, merge them, validate the append-only manifest, and commit only the accepted JSON:

```sh
gh run download <run-id> --dir <temporary-directory>
node benchmark/merge-results.js <temporary-directory>
npm run benchmark:validate
```

The merger rejects partial matrices, conflicting duplicates, nonpublishable evidence, rankings, non-baseline adapters, and results measured from a commit other than the current `HEAD`.

## Clean baseline

Workers run with `--expose-gc`. Memory is captured before adapter import, after import, connected, post-warm-up, post-run, and after close plus GC. A clean sample requires exact byte and message counts, natural process exits, no open sockets, no new active resources, an immediately reusable endpoint, and no leftover files in the private temporary root.

The development report also records RSS, heap, external and ArrayBuffer memory, maximum RSS, CPU, event-loop utilization, GC work, endpoint state, process IDs, OS/CPU/Node details, Git commit and dirty state, and oracle source/build identity. Tracked records remove process IDs, endpoints, ports, and absolute paths.

Full npm runs add a package-footprint report created from a fresh packed install: compressed and unpacked tarball bytes, package files, complete production install bytes/files, and direct, installed, and unique dependency counts. Comparator packages are isolated benchmark subjects; they are not node-ipc dependencies.

Fresh processes cannot clear the host page cache, thermal state, or unrelated load. Publish only clean-commit results from idle, identified machines, and compare the same operating system, transport semantics, reliability, payload, and oracle.
