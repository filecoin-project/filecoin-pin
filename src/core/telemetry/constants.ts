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

export const DEFAULT_OTLP_METRICS_ENDPOINT = 'https://s2455837.us-east-9.betterstackdata.com/v1/metrics'

export const DEFAULT_OTLP_METRICS_TOKEN = 'fs1TY3tELKDzThkm1SeWq18P'

/** OTel service name attached to every metric. */
export const TELEMETRY_SERVICE_NAME = 'filecoin-pin'

/** Counter: number of copies successfully uploaded. */
export const METRIC_UPLOAD_COPIES_SUCCESS = 'upload.copies.success'

/** Counter: number of copy upload errors. */
export const METRIC_UPLOAD_COPIES_FAILURE = 'upload.copies.failure'
