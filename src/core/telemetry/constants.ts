/**
 * Telemetry configuration constants.
 *
 * Metrics are submitted via OTLP/HTTP to BetterStack. The default endpoint and
 * authorization token are embedded here so that anonymous, opt-out telemetry
 * works out of the box. Because the token ships in source, the resulting data
 * source MUST be treated as public and untrusted — never rely on these metrics
 * for security or billing decisions.
 *
 * Operators can override both values with environment variables (see README).
 */

// TODO(#363): Replace with the real BetterStack OTLP ingest URL before release.
export const DEFAULT_OTLP_METRICS_ENDPOINT = 'https://__BETTERSTACK_HOST__/v1/metrics'

// TODO(#363): Replace with the real BetterStack source token before release.
export const DEFAULT_OTLP_METRICS_TOKEN = '__BETTERSTACK_SOURCE_TOKEN__'

/** OTel service name attached to every metric. */
export const TELEMETRY_SERVICE_NAME = 'filecoin-pin'

/** Counter: number of copies successfully uploaded. */
export const METRIC_UPLOAD_COPIES_SUCCESS = 'upload.copies.success'

/** Counter: number of copy upload errors. */
export const METRIC_UPLOAD_COPIES_FAILURE = 'upload.copies.failure'
