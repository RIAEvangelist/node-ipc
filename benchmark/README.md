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

## Clean baseline

Workers run with `--expose-gc`. Memory is captured before adapter import, after import, connected, post-warm-up, post-run, and after close plus GC. A clean sample requires exact byte and message counts, natural process exits, no open sockets, no new active resources, an immediately reusable endpoint, and no leftover files in the private temporary root.

The report also records RSS, heap, external and ArrayBuffer memory, maximum RSS, CPU, event-loop utilization, GC work, endpoint state, process IDs, OS/CPU/Node details, Git commit and dirty state, and oracle source/build identity.

Full npm runs add a package-footprint report created from a fresh packed install: compressed and unpacked tarball bytes, package files, complete production install bytes/files, and direct, installed, and unique dependency counts. Comparator packages are isolated benchmark subjects; they are not node-ipc dependencies.

Fresh processes cannot clear the host page cache, thermal state, or unrelated load. Publish only clean-commit results from idle, identified machines, and compare the same operating system, transport semantics, reliability, payload, and oracle.
