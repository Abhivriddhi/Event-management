import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeliveryError,
  countJobRecipients,
  getRetryDelayMs,
  getSafeErrorMessage,
  getTerminalJobStatus,
  parseBatchSize,
  parseRetryAfter,
  processBatchItems,
  recoverExpiredRecipient,
  shouldAutomaticallyRetry,
  splitIntoBatches,
  MAX_AUTOMATIC_RETRIES,
} from "../lib/services/jobQueueUtils.js";

test("batch sizes default to five and enforce integer limits from one through ten", () => {
  assert.equal(parseBatchSize(), 5);
  assert.equal(parseBatchSize("10"), 10);
  assert.equal(parseBatchSize(1), 1);
  for (const invalid of [0, 11, 1.5, "abc", null]) {
    assert.throws(() => parseBatchSize(invalid), /between 1 and 10/);
  }
});

test("small recipient lists form one partial batch", () => {
  assert.deepEqual(splitIntoBatches(3, 5), [[0, 1, 2]]);
});

test("exactly one full batch stays one batch", () => {
  assert.deepEqual(splitIntoBatches(5, 5), [[0, 1, 2, 3, 4]]);
});

test("multiple batches continue and retain a final partial batch", () => {
  assert.deepEqual(splitIntoBatches(12, 5), [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
    [10, 11],
  ]);
});

test("batch runner automatically continues later batches and preserves a final partial batch", async () => {
  const recipients = Array.from({ length: 12 }, () => ({ status: "PENDING" }));
  const batchSizes = [];
  while (recipients.some((recipient) => recipient.status === "PENDING")) {
    batchSizes.push(await processBatchItems({
      recipients,
      batchSize: 5,
      processItem: async (_, recipient) => { recipient.status = "SENT"; },
    }));
  }
  assert.deepEqual(batchSizes, [5, 5, 2]);
});

test("one recipient failure does not stop other recipients in the same batch", async () => {
  const recipients = Array.from({ length: 5 }, () => ({ status: "PENDING" }));
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    processItem: async (index, recipient) => {
      recipient.status = index === 2 ? "FAILED" : "SENT";
    },
  });
  assert.equal(processed, 5);
  assert.equal(recipients.filter((recipient) => recipient.status === "SENT").length, 4);
  assert.equal(recipients.filter((recipient) => recipient.status === "FAILED").length, 1);
});

test("batch runner leaves successful recipients alone and skips retry-delayed recipients", async () => {
  const recipients = [
    { status: "SENT" },
    { status: "PENDING", nextAttemptAt: new Date(Date.now() + 60_000) },
    { status: "PENDING" },
  ];
  const processedIndexes = [];
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    processItem: async (index, recipient) => {
      processedIndexes.push(index);
      recipient.status = "SENT";
    },
  });
  assert.equal(processed, 1);
  assert.deepEqual(processedIndexes, [2]);
});

test("empty recipient lists do not create phantom batches", () => {
  assert.deepEqual(splitIntoBatches(0, 5), []);
});

test("recipient counts distinguish pending, processing, success, failure, and unknown", () => {
  assert.deepEqual(countJobRecipients([
    { status: "PENDING" },
    { status: "PROCESSING" },
    { status: "SENDING" },
    { status: "SENT" },
    { status: "FAILED" },
    { status: "UNKNOWN" },
  ]), {
    pendingCount: 1,
    processingCount: 2,
    successfulCount: 1,
    failedCount: 1,
    unknownCount: 1,
  });
});

test("terminal job states do not complete while work is pending or processing", () => {
  assert.equal(getTerminalJobStatus({ pendingCount: 1, processingCount: 0 }), null);
  assert.equal(getTerminalJobStatus({ pendingCount: 0, processingCount: 1 }), null);
  assert.equal(getTerminalJobStatus({ pendingCount: 0, processingCount: 0, successfulCount: 2, failedCount: 0, unknownCount: 0 }), "COMPLETED");
  assert.equal(getTerminalJobStatus({ pendingCount: 0, processingCount: 0, successfulCount: 1, failedCount: 1, unknownCount: 0 }), "PARTIAL");
  assert.equal(getTerminalJobStatus({ pendingCount: 0, processingCount: 0, successfulCount: 0, failedCount: 0, unknownCount: 1 }), "FAILED");
});

test("pre-delivery 429, 5xx, and network failures are safe transient retries", () => {
  assert.equal(classifyDeliveryError({ status: 429 }).kind, "transient");
  assert.equal(classifyDeliveryError({ status: 503 }).kind, "transient");
  assert.equal(classifyDeliveryError({ cause: { code: "ECONNRESET" } }).kind, "transient");
});

test("permanent pre-delivery client errors are not retried", () => {
  assert.deepEqual(classifyDeliveryError({ status: 400 }), { kind: "permanent", retryable: false });
});

test("SMTP 4xx rejections are transient and 5xx rejections are permanent", () => {
  assert.deepEqual(classifyDeliveryError({ responseCode: 450 }, true), { kind: "transient", retryable: true });
  assert.deepEqual(classifyDeliveryError({ responseCode: 550 }, true), { kind: "permanent", retryable: false });
});

test("network failures after delivery starts remain unknown rather than being blindly retried", () => {
  assert.deepEqual(classifyDeliveryError({ code: "ETIMEDOUT" }, true), { kind: "unknown", retryable: false });
});

test("automatic retries stop at the configured maximum", () => {
  const transient = { kind: "transient", retryable: true };
  assert.equal(shouldAutomaticallyRetry(transient, MAX_AUTOMATIC_RETRIES - 1), true);
  assert.equal(shouldAutomaticallyRetry(transient, MAX_AUTOMATIC_RETRIES), false);
  assert.equal(shouldAutomaticallyRetry({ kind: "permanent" }, 0), false);
});

test("Retry-After parses seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("12"), 12_000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:20 GMT", 10_000), 10_000);
  assert.equal(parseRetryAfter("not a date"), 0);
});

test("backoff increases exponentially and includes bounded jitter", () => {
  assert.equal(getRetryDelayMs(1, 0, () => 0), 5_000);
  assert.equal(getRetryDelayMs(2, 0, () => 1), 12_500);
  assert.equal(getRetryDelayMs(20, 0, () => 1), 375_000);
});

test("Retry-After takes precedence over computed backoff", () => {
  assert.equal(getRetryDelayMs(1, 60_000, () => 0), 60_000);
});

test("expired preparation is resumable while expired delivery is not resent automatically", () => {
  assert.equal(recoverExpiredRecipient({ status: "PROCESSING" }).status, "PENDING");
  const unknown = recoverExpiredRecipient({ status: "SENDING" });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.retryable, false);
});

test("diagnostic messages redact email addresses and credential-like values", () => {
  assert.equal(
    getSafeErrorMessage({ message: "Failed for admin@example.com with token=abc123" }),
    "Failed for [email] with token=[redacted]"
  );
});
