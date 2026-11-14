/**
 * Fail-closed, response-only OTLP/HTTP JSON receipt classifier.
 * This is a test oracle, not a substitute for network or storage readback.
 */
const REJECTED_FIELD = Object.freeze({
  traces: "rejectedSpans",
  logs: "rejectedLogRecords",
  metrics: "rejectedDataPoints",
});

export function classify_otlp_receipt({
  signal, status, content_type, body,
}) {
  const reject = Object.freeze({accepted: false, partial: false, outcome: "invalid_receipt"});
  const field = REJECTED_FIELD[signal];
  if (!field || status !== 200 || typeof content_type !== "string" ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(content_type) ||
      typeof body !== "string" || !body || Buffer.byteLength(body, "utf8") > 65536) {
    return reject;
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return reject;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject;
  const result = value.partialSuccess;
  if (result == null) {
    return Object.freeze({accepted: true, partial: false, outcome: "accepted"});
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return reject;
  const count = result[field] ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) return reject;
  // A nonzero rejected-record count is a partial acceptance, never a full ACK.
  return Object.freeze(count > 0
    ? {accepted: true, partial: true, outcome: "partial_acceptance"}
    : {accepted: true, partial: false, outcome: "accepted"});
}
