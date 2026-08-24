-- query: performance
WITH
document(body,schema_version) AS (
    SELECT json(benchmark_result()),json_extract(benchmark_result(),'$.schemaVersion')
),
lane_order AS (
    SELECT CAST(key AS INTEGER) AS lane_order,value AS lane_id
    FROM document,json_each(body,'$.config.laneIds')
    WHERE schema_version=2
    UNION ALL
    SELECT CAST(key AS INTEGER),value
    FROM document,json_each(body,'$.config.subjects')
    WHERE schema_version=1
),
payloads AS (
    SELECT CAST(key AS INTEGER) AS payload_order,value AS payload_bytes
    FROM document,json_each(body,'$.config.payloads')
),
legacy_sample_meta AS (
    SELECT
        json_extract(value,'$.subjectId') AS module_id,
        json_extract(value,'$.subject.topology') AS topology,
        json_extract(value,'$.subject.serialization') AS serialization
    FROM document,json_each(body,'$.samples')
    WHERE schema_version=1
    GROUP BY module_id,topology,serialization
),
dimension_lanes AS (
    SELECT key AS lane_id,value AS lane
    FROM document,json_each(body,'$.dimensions.lanes')
    WHERE schema_version=2
    UNION ALL
    SELECT key,value
    FROM document,json_each(body,'$.dimensions.cases')
    WHERE schema_version=2 AND json_type(body,'$.dimensions.lanes') IS NULL
),
lanes AS (
    SELECT
        dimension_lanes.lane_id,
        json_extract(lane,'$.moduleId') AS module_id,
        json_extract(lane,'$.transportId') AS transport_id,
        json_extract(lane,'$.cohortId') AS cohort_id,
        json_extract(lane,'$.label') AS lane,
        json_extract(lane,'$.protocolStack') AS protocol_stack,
        json_extract(lane,'$.topology') AS topology,
        json_extract(lane,'$.serialization') AS serialization,
        json_extract(lane,'$.securityMode') AS security_mode
    FROM dimension_lanes
    UNION ALL
    SELECT
        lane_order.lane_id,
        lane_order.lane_id,
        CASE lane_order.lane_id WHEN 'native-child-process' THEN 'process-ipc' ELSE 'tcp' END,
        CASE lane_order.lane_id WHEN 'native-child-process' THEN 'process-ipc' ELSE 'tcp' END,
        json_extract(catalog.value,'$.label'),
        json_array(legacy_sample_meta.serialization),
        legacy_sample_meta.topology,
        legacy_sample_meta.serialization,
        'plaintext'
    FROM document
    JOIN lane_order
    JOIN json_each(body,'$.catalog.subjects') AS catalog ON catalog.key=lane_order.lane_id
    JOIN legacy_sample_meta ON legacy_sample_meta.module_id=lane_order.lane_id
    WHERE schema_version=1
),
transports AS (
    SELECT
        key AS transport_id,
        json_extract(value,'$.label') AS transport,
        json_extract(value,'$.family') AS transport_family,
        json_extract(value,'$.implementation') AS transport_implementation,
        json_extract(value,'$.scope') AS transport_scope
    FROM document,json_each(body,'$.dimensions.transports')
    WHERE schema_version=2
    UNION ALL
    SELECT 'process-ipc','Platform process IPC channel','process-ipc','platform-ipc-channel','parent-child'
    FROM document WHERE schema_version=1
    UNION ALL
    SELECT 'tcp','TCP loopback','stream','tcp-loopback','loopback'
    FROM document WHERE schema_version=1
),
catalog AS (
    SELECT key AS module_id,json_extract(value,'$.label') AS module
    FROM document,json_each(body,'$.catalog.subjects')
),
summary_rows AS (
    SELECT
        COALESCE(json_extract(value,'$.laneId'),json_extract(value,'$.subject')) AS lane_id,
        json_extract(value,'$.payloadBytes') AS payload_bytes,
        json_extract(value,'$.workload') AS workload,
        value AS summary
    FROM document,json_each(body,'$.summary')
),
throughput AS (
    SELECT lane_id,payload_bytes,summary FROM summary_rows WHERE workload='throughput'
),
latency AS (
    SELECT lane_id,payload_bytes,summary FROM summary_rows WHERE workload='latency'
),
dependencies AS (
    SELECT key AS module_id,value AS dependency
    FROM document,json_each(body,'$.dependencyExposure')
),
complexity AS (
    SELECT key AS owner_id,value AS complexity
    FROM document,json_each(body,'$.complexity')
)
SELECT
    lane_order.lane_id AS laneId,
    lanes.module_id AS moduleId,
    lanes.module_id AS subjectId,
    catalog.module AS subject,
    lanes.lane,
    lanes.transport_id AS transportId,
    lanes.cohort_id AS cohortId,
    transports.transport,
    transports.transport_family AS transportFamily,
    transports.transport_implementation AS transportImplementation,
    transports.transport_scope AS transportScope,
    lanes.protocol_stack AS protocolStack,
    lanes.topology,
    lanes.serialization,
    lanes.security_mode AS securityMode,
    CASE payloads.payload_bytes
        WHEN 64 THEN '64 B'
        WHEN 4096 THEN '4 KiB'
        WHEN 65536 THEN '64 KiB'
        ELSE CAST(payloads.payload_bytes AS TEXT)||' B'
    END AS payload,
    payloads.payload_bytes AS payloadBytes,
    ROUND(json_extract(throughput.summary,'$.roundTripsPerSecond.median'),1) AS throughputRps,
    ROUND(json_extract(throughput.summary,'$.roundTripsPerSecond.iqr'),1) AS throughputIqrRps,
    ROUND(json_extract(throughput.summary,'$.applicationMiBPerSecond.median'),3) AS applicationMiBps,
    ROUND(json_extract(latency.summary,'$.latencyNs.p50.median')/1000.0,1) AS latencyP50Us,
    ROUND(json_extract(latency.summary,'$.latencyNs.p95.median')/1000.0,1) AS latencyP95Us,
    ROUND(json_extract(latency.summary,'$.latencyNs.p99.median')/1000.0,1) AS latencyP99Us,
    json_extract(dependencies.dependency,'$.uniqueResolvedDependencies') AS dependencyCount,
    COALESCE(
        json_extract(lane_complexity.complexity,'$.sourceLines'),
        json_extract(module_complexity.complexity,'$.sourceLines')
    ) AS adapterSloc,
    COALESCE(json_extract(throughput.summary,'$.samples'),0) AS throughputSamples,
    COALESCE(json_extract(latency.summary,'$.samples'),0) AS latencySamples,
    COALESCE(json_extract(throughput.summary,'$.failures'),0)
        + COALESCE(json_extract(latency.summary,'$.failures'),0) AS failures
FROM lane_order
JOIN lanes USING(lane_id)
JOIN catalog ON catalog.module_id=lanes.module_id
JOIN transports USING(transport_id)
CROSS JOIN payloads
LEFT JOIN throughput ON throughput.lane_id=lane_order.lane_id AND throughput.payload_bytes=payloads.payload_bytes
LEFT JOIN latency ON latency.lane_id=lane_order.lane_id AND latency.payload_bytes=payloads.payload_bytes
LEFT JOIN dependencies ON dependencies.module_id=lanes.module_id
LEFT JOIN complexity AS lane_complexity ON lane_complexity.owner_id=lane_order.lane_id
LEFT JOIN complexity AS module_complexity ON module_complexity.owner_id=lanes.module_id
ORDER BY lane_order.lane_order,payloads.payload_order;

-- query: exposure
WITH
document(body,schema_version) AS (
    SELECT json(benchmark_result()),json_extract(benchmark_result(),'$.schemaVersion')
),
module_order AS (
    SELECT CAST(key AS INTEGER) AS module_order,value AS module_id
    FROM document,json_each(body,'$.config.moduleIds')
    WHERE schema_version=2
    UNION ALL
    SELECT CAST(key AS INTEGER),value
    FROM document,json_each(body,'$.config.subjects')
    WHERE schema_version=1
),
dimension_lanes AS (
    SELECT key AS lane_id,value AS lane
    FROM document,json_each(body,'$.dimensions.lanes')
    WHERE schema_version=2
    UNION ALL
    SELECT key,value
    FROM document,json_each(body,'$.dimensions.cases')
    WHERE schema_version=2 AND json_type(body,'$.dimensions.lanes') IS NULL
),
lane_inventory AS (
    SELECT
        json_extract(lane,'$.moduleId') AS module_id,
        COUNT(*) AS lane_count,
        group_concat(DISTINCT json_extract(lane,'$.transportId')) AS transport_ids
    FROM dimension_lanes
    JOIN (
        SELECT value AS lane_id
        FROM document,json_each(body,'$.config.laneIds')
        WHERE schema_version=2
    ) AS selected_lanes USING(lane_id)
    GROUP BY module_id
),
catalog AS (
    SELECT key AS module_id,json_extract(value,'$.label') AS module
    FROM document,json_each(body,'$.catalog.subjects')
),
dependencies AS (
    SELECT key AS module_id,value AS dependency
    FROM document,json_each(body,'$.dependencyExposure')
),
complexity AS (
    SELECT key AS owner_id,value AS complexity
    FROM document,json_each(body,'$.complexity')
)
SELECT
    module_order.module_id AS moduleId,
    module_order.module_id AS subjectId,
    catalog.module AS subject,
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
    COALESCE(lane_inventory.lane_count,1) AS laneCount,
    COALESCE(lane_inventory.transport_ids,
        CASE module_order.module_id WHEN 'native-child-process' THEN 'process-ipc' ELSE 'tcp' END
    ) AS transportIds
FROM module_order
JOIN catalog USING(module_id)
JOIN dependencies USING(module_id)
LEFT JOIN complexity ON complexity.owner_id=module_order.module_id
LEFT JOIN lane_inventory USING(module_id)
ORDER BY module_order.module_order;

-- query: capabilities
WITH
document(body,schema_version) AS (
    SELECT json(benchmark_result()),json_extract(benchmark_result(),'$.schemaVersion')
),
module_order AS (
    SELECT CAST(key AS INTEGER) AS module_order,value AS module_id
    FROM document,json_each(body,'$.config.moduleIds')
    WHERE schema_version=2
    UNION ALL
    SELECT CAST(key AS INTEGER),value
    FROM document,json_each(body,'$.config.subjects')
    WHERE schema_version=1
),
catalog AS (
    SELECT key AS module_id,json_extract(value,'$.label') AS module
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
    SELECT key AS module_id,value AS capabilities
    FROM document,json_each(body,'$.capabilities.matrix')
)
SELECT
    module_order.module_id AS moduleId,
    module_order.module_id AS subjectId,
    catalog.module AS subject,
    definitions.capability,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.status') AS status,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.note') AS note,
    json_extract(matrix.capabilities,'$.'||definitions.capability_id||'.source') AS source
FROM module_order
JOIN catalog USING(module_id)
JOIN matrix USING(module_id)
CROSS JOIN definitions
ORDER BY module_order.module_order,definitions.capability_order;

-- query: transport-lanes
WITH
document(body,schema_version) AS (
    SELECT json(benchmark_result()),json_extract(benchmark_result(),'$.schemaVersion')
),
lane_order AS (
    SELECT CAST(key AS INTEGER) AS lane_order,value AS lane_id
    FROM document,json_each(body,'$.config.laneIds')
    WHERE schema_version=2
    UNION ALL
    SELECT CAST(key AS INTEGER),value
    FROM document,json_each(body,'$.config.subjects')
    WHERE schema_version=1
),
dimension_lanes AS (
    SELECT key AS lane_id,value AS lane
    FROM document,json_each(body,'$.dimensions.lanes')
    WHERE schema_version=2
    UNION ALL
    SELECT key,value
    FROM document,json_each(body,'$.dimensions.cases')
    WHERE schema_version=2 AND json_type(body,'$.dimensions.lanes') IS NULL
),
legacy_sample_meta AS (
    SELECT
        json_extract(value,'$.subjectId') AS module_id,
        json_extract(value,'$.subject.topology') AS topology,
        json_extract(value,'$.subject.serialization') AS serialization
    FROM document,json_each(body,'$.samples')
    WHERE schema_version=1
    GROUP BY module_id,topology,serialization
),
lanes AS (
    SELECT
        dimension_lanes.lane_id,
        json_extract(lane,'$.moduleId') AS module_id,
        json_extract(lane,'$.transportId') AS transport_id,
        json_extract(lane,'$.cohortId') AS cohort_id,
        json_extract(lane,'$.label') AS lane,
        json_extract(lane,'$.protocolStack') AS protocol_stack,
        json_extract(lane,'$.topology') AS topology,
        json_extract(lane,'$.serialization') AS serialization,
        json_extract(lane,'$.securityMode') AS security_mode,
        json_extract(lane,'$.sourceFiles') AS source_files
    FROM dimension_lanes
    UNION ALL
    SELECT
        lane_order.lane_id,lane_order.lane_id,
        CASE lane_order.lane_id WHEN 'native-child-process' THEN 'process-ipc' ELSE 'tcp' END,
        CASE lane_order.lane_id WHEN 'native-child-process' THEN 'process-ipc' ELSE 'tcp' END,
        json_extract(catalog.value,'$.label'),json_array(legacy_sample_meta.serialization),
        legacy_sample_meta.topology,legacy_sample_meta.serialization,'plaintext',json('[]')
    FROM document
    JOIN lane_order
    JOIN json_each(body,'$.catalog.subjects') AS catalog ON catalog.key=lane_order.lane_id
    JOIN legacy_sample_meta ON legacy_sample_meta.module_id=lane_order.lane_id
    WHERE schema_version=1
),
transports AS (
    SELECT
        key AS transport_id,
        json_extract(value,'$.label') AS transport,
        json_extract(value,'$.family') AS family,
        json_extract(value,'$.implementation') AS implementation,
        json_extract(value,'$.scope') AS scope
    FROM document,json_each(body,'$.dimensions.transports')
    WHERE schema_version=2
    UNION ALL
    SELECT 'process-ipc','Platform process IPC channel','process-ipc','platform-ipc-channel','parent-child'
    FROM document WHERE schema_version=1
    UNION ALL
    SELECT 'tcp','TCP loopback','stream','tcp-loopback','loopback'
    FROM document WHERE schema_version=1
),
catalog AS (
    SELECT key AS module_id,json_extract(value,'$.label') AS module
    FROM document,json_each(body,'$.catalog.subjects')
),
complexity AS (
    SELECT key AS owner_id,value AS complexity
    FROM document,json_each(body,'$.complexity')
)
SELECT
    lane_order.lane_id AS laneId,
    lanes.module_id AS moduleId,
    catalog.module AS module,
    lanes.lane,
    lanes.transport_id AS transportId,
    lanes.cohort_id AS cohortId,
    transports.transport,
    transports.family AS transportFamily,
    transports.implementation AS transportImplementation,
    transports.scope AS transportScope,
    lanes.protocol_stack AS protocolStack,
    lanes.topology,
    lanes.serialization,
    lanes.security_mode AS securityMode,
    lanes.source_files AS sourceFiles,
    COALESCE(
        json_extract(lane_complexity.complexity,'$.sourceLines'),
        json_extract(module_complexity.complexity,'$.sourceLines')
    ) AS adapterSloc,
    COALESCE(
        json_extract(document.body,'$.evidence.comparison.crossTransportRankingEligible'),
        0
    ) AS crossTransportRankingEligible
FROM lane_order
JOIN lanes USING(lane_id)
JOIN catalog ON catalog.module_id=lanes.module_id
JOIN transports USING(transport_id)
LEFT JOIN complexity AS lane_complexity ON lane_complexity.owner_id=lane_order.lane_id
LEFT JOIN complexity AS module_complexity ON module_complexity.owner_id=lanes.module_id
CROSS JOIN document
ORDER BY lane_order.lane_order;

-- query: transport-coverage
WITH
document(body,schema_version) AS (
    SELECT json(benchmark_result()),json_extract(benchmark_result(),'$.schemaVersion')
),
module_order AS (
    SELECT CAST(key AS INTEGER) AS module_order,value AS module_id
    FROM document,json_each(body,'$.config.moduleIds')
    WHERE schema_version=2
),
catalog AS (
    SELECT key AS module_id,json_extract(value,'$.label') AS module
    FROM document,json_each(body,'$.catalog.subjects')
),
transport_definitions AS (
    SELECT
        CAST(key AS INTEGER) AS transport_order,
        json_extract(value,'$.id') AS transport_id,
        json_extract(value,'$.label') AS transport
    FROM document,json_each(body,'$.capabilities.transportDefinitions')
),
matrix AS (
    SELECT key AS module_id,value AS transports
    FROM document,json_each(body,'$.capabilities.transportMatrix')
)
SELECT
    module_order.module_id AS moduleId,
    catalog.module,
    transport_definitions.transport_id AS transportId,
    transport_definitions.transport,
    json_extract(
        matrix.transports,
        '$."'||transport_definitions.transport_id||'".status'
    ) AS status,
    json_extract(
        matrix.transports,
        '$."'||transport_definitions.transport_id||'".note'
    ) AS note,
    json_extract(
        matrix.transports,
        '$."'||transport_definitions.transport_id||'".source'
    ) AS source
FROM module_order
JOIN catalog USING(module_id)
JOIN matrix USING(module_id)
CROSS JOIN transport_definitions
ORDER BY module_order.module_order,transport_definitions.transport_order;
