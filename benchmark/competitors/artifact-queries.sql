-- query: performance
WITH
document(body) AS (
    SELECT json(readfile('benchmark/competitors/results/windows-node24-20260823.json'))
),
subject_order AS (
    SELECT CAST(key AS INTEGER) AS subject_order,value AS subject_id
    FROM document,json_each(body,'$.config.subjects')
),
subject_meta AS (
    SELECT
        json_extract(value,'$.subjectId') AS subject_id,
        json_extract(value,'$.subject.transport') AS transport,
        json_extract(value,'$.subject.topology') AS topology
    FROM document,json_each(body,'$.samples')
    GROUP BY subject_id,transport,topology
),
catalog AS (
    SELECT key AS subject_id,json_extract(value,'$.label') AS subject
    FROM document,json_each(body,'$.catalog.subjects')
),
throughput AS (
    SELECT
        json_extract(value,'$.subject') AS subject_id,
        json_extract(value,'$.payloadBytes') AS payload_bytes,
        json_extract(value,'$.roundTripsPerSecond.median') AS throughput_rps,
        json_extract(value,'$.roundTripsPerSecond.iqr') AS throughput_iqr_rps,
        json_extract(value,'$.applicationMiBPerSecond.median') AS application_mibps,
        json_extract(value,'$.samples') AS samples,
        json_extract(value,'$.failures') AS failures
    FROM document,json_each(body,'$.summary')
    WHERE json_extract(value,'$.workload')='throughput'
),
latency AS (
    SELECT
        json_extract(value,'$.subject') AS subject_id,
        json_extract(value,'$.payloadBytes') AS payload_bytes,
        json_extract(value,'$.latencyNs.p50.median')/1000.0 AS latency_p50_us,
        json_extract(value,'$.latencyNs.p95.median')/1000.0 AS latency_p95_us,
        json_extract(value,'$.latencyNs.p99.median')/1000.0 AS latency_p99_us,
        json_extract(value,'$.failures') AS failures
    FROM document,json_each(body,'$.summary')
    WHERE json_extract(value,'$.workload')='latency'
),
dependencies AS (
    SELECT key AS subject_id,value AS dependency
    FROM document,json_each(body,'$.dependencyExposure')
),
complexity AS (
    SELECT key AS subject_id,value AS complexity
    FROM document,json_each(body,'$.complexity')
)
SELECT
    subject_order.subject_id AS subjectId,
    catalog.subject,
    CASE throughput.payload_bytes
        WHEN 64 THEN '64 B'
        WHEN 4096 THEN '4 KiB'
        WHEN 65536 THEN '64 KiB'
        ELSE CAST(throughput.payload_bytes AS TEXT)||' B'
    END AS payload,
    throughput.payload_bytes AS payloadBytes,
    subject_meta.transport,
    subject_meta.topology,
    ROUND(throughput.throughput_rps,1) AS throughputRps,
    ROUND(throughput.throughput_iqr_rps,1) AS throughputIqrRps,
    ROUND(throughput.application_mibps,3) AS applicationMiBps,
    ROUND(latency.latency_p50_us,1) AS latencyP50Us,
    ROUND(latency.latency_p95_us,1) AS latencyP95Us,
    ROUND(latency.latency_p99_us,1) AS latencyP99Us,
    json_extract(dependencies.dependency,'$.uniqueResolvedDependencies') AS dependencyCount,
    json_extract(complexity.complexity,'$.sourceLines') AS adapterSloc,
    throughput.samples,
    throughput.failures+latency.failures AS failures
FROM subject_order
JOIN subject_meta USING(subject_id)
JOIN catalog USING(subject_id)
JOIN throughput USING(subject_id)
JOIN latency USING(subject_id,payload_bytes)
JOIN dependencies USING(subject_id)
JOIN complexity USING(subject_id)
ORDER BY subject_order.subject_order,throughput.payload_bytes;

-- query: exposure
WITH
document(body) AS (
    SELECT json(readfile('benchmark/competitors/results/windows-node24-20260823.json'))
),
subject_order AS (
    SELECT CAST(key AS INTEGER) AS subject_order,value AS subject_id
    FROM document,json_each(body,'$.config.subjects')
),
subject_meta AS (
    SELECT
        json_extract(value,'$.subjectId') AS subject_id,
        json_extract(value,'$.subject.transport') AS transport,
        json_extract(value,'$.subject.topology') AS topology
    FROM document,json_each(body,'$.samples')
    GROUP BY subject_id,transport,topology
),
catalog AS (
    SELECT key AS subject_id,json_extract(value,'$.label') AS subject
    FROM document,json_each(body,'$.catalog.subjects')
),
dependencies AS (
    SELECT key AS subject_id,value AS dependency
    FROM document,json_each(body,'$.dependencyExposure')
),
complexity AS (
    SELECT key AS subject_id,value AS complexity
    FROM document,json_each(body,'$.complexity')
)
SELECT
    subject_order.subject_id AS subjectId,
    catalog.subject,
    json_extract(dependencies.dependency,'$.directUniqueDependencies') AS directDependencyNames,
    json_extract(dependencies.dependency,'$.directDependencyEdges') AS directDependencyEdges,
    json_extract(dependencies.dependency,'$.uniqueResolvedDependencies') AS uniqueResolvedDependencies,
    json_extract(dependencies.dependency,'$.installedDependencyInstances') AS installedDependencyInstances,
    COALESCE(NULLIF((
        SELECT group_concat(value,', ')
        FROM json_each(dependencies.dependency,'$.packagesWithInstallScripts')
    ),''),'none') AS installScriptPackages,
    json_extract(dependencies.dependency,'$.riskTier') AS exposureTier,
    json_extract(complexity.complexity,'$.sourceLines') AS adapterSloc,
    json_extract(complexity.complexity,'$.implementationBytes') AS adapterBytes,
    json_extract(complexity.complexity,'$.implementationFiles') AS adapterFiles,
    subject_meta.transport,
    subject_meta.topology
FROM subject_order
JOIN subject_meta USING(subject_id)
JOIN catalog USING(subject_id)
JOIN dependencies USING(subject_id)
JOIN complexity USING(subject_id)
ORDER BY subject_order.subject_order;

-- query: capabilities
WITH
document(body) AS (
    SELECT json(readfile('benchmark/competitors/results/windows-node24-20260823.json'))
),
subject_order AS (
    SELECT CAST(key AS INTEGER) AS subject_order,value AS subject_id
    FROM document,json_each(body,'$.config.subjects')
),
subject_meta AS (
    SELECT
        json_extract(value,'$.subjectId') AS subject_id,
        json_extract(value,'$.subject.transport') AS transport,
        json_extract(value,'$.subject.topology') AS topology
    FROM document,json_each(body,'$.samples')
    GROUP BY subject_id,transport,topology
),
catalog AS (
    SELECT key AS subject_id,json_extract(value,'$.label') AS subject
    FROM document,json_each(body,'$.catalog.subjects')
),
definitions AS (
    SELECT
        CAST(key AS INTEGER) AS capability_order,
        json_extract(value,'$.id') AS capability_id,
        json_extract(value,'$.label') AS capability
    FROM document,json_each(body,'$.capabilities.definitions')
),
matrix AS (
    SELECT key AS subject_id,value AS capabilities
    FROM document,json_each(body,'$.capabilities.matrix')
)
SELECT
    subject_order.subject_id AS subjectId,
    catalog.subject,
    definitions.capability,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.status') AS status,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.note') AS note,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.source') AS source,
    subject_meta.transport,
    subject_meta.topology
FROM subject_order
JOIN subject_meta USING(subject_id)
JOIN catalog USING(subject_id)
JOIN matrix USING(subject_id)
CROSS JOIN definitions
ORDER BY subject_order.subject_order,definitions.capability_order;
