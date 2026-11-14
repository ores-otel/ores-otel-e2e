import assert from "node:assert/strict";
import test from "node:test";
import {classify_otlp_receipt} from "./receipt-check.mjs";

function classify(signal, body, status = 200, content_type = "application/json") {
  return classify_otlp_receipt({signal, body, status, content_type});
}

test("accepts correctly shaped success acknowledgments for three OTLP signals", () => {
  for (const signal of ["traces", "logs", "metrics"]) {
    assert.deepEqual(classify(signal, "{}"),
      {accepted: true, partial: false, outcome: "accepted"});
  }
});

test("nonzero partial success cannot be reported as a full acknowledgment", () => {
  const fields = {traces: "rejectedSpans", logs: "rejectedLogRecords", metrics: "rejectedDataPoints"};
  for (const [signal, field] of Object.entries(fields)) {
    const result = classify(signal, JSON.stringify({partialSuccess: {[field]: 1}}));
    assert.deepEqual(result,
      {accepted: true, partial: true, outcome: "partial_acceptance"});
  }
});

test("invalid receipts fail closed without surfacing raw exporter content", () => {
  for (const body of ["", "not json", "[]", "null", "0", '{"partialSuccess":"oops"}',
      '{"partialSuccess":{"rejectedSpans":-1}}',
      '{"partialSuccess":{"rejectedSpans":1.5}}', "x".repeat(65537)]) {
    const result = classify("traces", body);
    assert.deepEqual(result,
      {accepted: false, partial: false, outcome: "invalid_receipt"});
    assert.ok(!JSON.stringify(result).includes("oops"));
  }
});

test("rejects status, media type and signal confusion", () => {
  for (const item of [
    {signal: "traces", status: 503, content_type: "application/json", body: "{}"},
    {signal: "traces", status: 200, content_type: "text/html", body: "{}"},
    {signal: "unknown", status: 200, content_type: "application/json", body: "{}"},
  ]) {
    assert.equal(classify_otlp_receipt(item).accepted, false);
  }
});
