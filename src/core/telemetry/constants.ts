/**
 * Telemetry configuration constants.
 *
 * Metrics are submitted via direct HTTP POST to BetterStack
 * (https://betterstack.com/docs/logs/ingesting-data/http/metrics/). The
 * endpoint and authorization token are embedded here so that anonymous, opt-out
 * telemetry works out of the box. Because the token ships in source, the
 * resulting data source MUST be treated as public and untrusted — never rely
 * on these metrics for security or billing decisions.
 *
 * These values are fixed; they are intentionally not configurable.
 */

export const METRICS_ENDPOINT = 'https://s2455837.us-east-9.betterstackdata.com/metrics'

export const METRICS_TOKEN = 'fs1TY3tELKDzThkm1SeWq18P'

/**
 * Counter: one increment per resolved upload copy attempt, carrying a
 * `value` tag (`success`, `failure.pull`, `failure.commit`, `failure.other`).
 * See `documentation/events-and-metrics.md` for the full schema.
 */
export const METRIC_UPLOAD_COPY_STATUS = 'uploadCopyStatus'

/**
 * Gauge: piece size in bytes, emitted alongside every
 * {@link METRIC_UPLOAD_COPY_STATUS} point with the same tag set. Lets dashboards
 * slice success/failure rates by size (e.g. p99 size of commit-step failures)
 * without inflating the counter's tag cardinality.
 */
export const METRIC_UPLOAD_COPY_SIZE = 'uploadCopySize'
