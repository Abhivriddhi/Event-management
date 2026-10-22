import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeliveryError,
  claimLease,
  countJobRecipients,
  effectiveBatchSize,
  getRetryDelayMs,
  getSafeErrorMessage,
  getTerminalJobStatus,
  getUnleasedJobStatus,
  MAX_BATCH_RUNTIME_MS,
  parseBatchSize,
  parseRetryAfter,
  processBatchItems,
  recoverExpiredRecipient,
  shouldAutomaticallyRetry,
  splitIntoBatches,
  MAX_AUTOMATIC_RETRIES,
} from "../lib/services/jobQueueUtils.js";

test("batch sizes default to ten and enforce limits from one through fifteen", () => {
  assert.equal(parseBatchSize(), 10);
  assert.equal(parseBatchSize(1), 1);
  assert.equal(parseBatchSize(15), 15);
  assert.equal(effectiveBatchSize(1), 1);
  assert.equal(effectiveBatchSize(15), 15);
  for (const invalid of [0, 16, 1.5, "abc", null]) {
    assert.throws(() => parseBatchSize(invalid), /between 1 and 15/);
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

test("a batch request processes no more than one batch", async () => {
  const recipients = Array.from({ length: 12 }, () => ({ status: "PENDING" }));
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    processItem: async (_, recipient) => { recipient.status = "SENT"; },
  });
  assert.equal(processed, 5);
  assert.equal(recipients.filter((recipient) => recipient.status === "SENT").length, 5);
  assert.equal(recipients.filter((recipient) => recipient.status === "PENDING").length, 7);
});

test("repeated manual requests process only one additional batch each", async () => {
  const recipients = Array.from({ length: 12 }, () => ({ status: "PENDING" }));
  const processOneRequest = () => processBatchItems({
    recipients,
    batchSize: 5,
    processItem: async (_, recipient) => { recipient.status = "SENT"; },
  });
  assert.equal(await processOneRequest(), 5);
  assert.equal(await processOneRequest(), 5);
  assert.equal(recipients.filter((recipient) => recipient.status === "SENT").length, 10);
  assert.equal(recipients.filter((recipient) => recipient.status === "PENDING").length, 2);
});

test("a numbered batch processes only recipients in its selected range", async () => {
  const recipients = Array.from({ length: 12 }, () => ({ status: "PENDING" }));
  const processedIndexes = [];
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    recipientIndices: [5, 6, 7, 8, 9],
    processItem: async (index, recipient) => {
      processedIndexes.push(index);
      recipient.status = "SENT";
    },
  });
  assert.equal(processed, 5);
  assert.deepEqual(processedIndexes, [5, 6, 7, 8, 9]);
  assert.equal(recipients.filter((recipient) => recipient.status === "SENT").length, 5);
  assert.equal(recipients.filter((recipient) => recipient.status === "PENDING").length, 7);
});

test("a numbered final partial batch processes only its remaining recipients", async () => {
  const recipients = Array.from({ length: 12 }, () => ({ status: "PENDING" }));
  const processedIndexes = [];
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    recipientIndices: [10, 11],
    processItem: async (index, recipient) => {
      processedIndexes.push(index);
      recipient.status = "SENT";
    },
  });
  assert.equal(processed, 2);
  assert.deepEqual(processedIndexes, [10, 11]);
  assert.equal(recipients.filter((recipient) => recipient.status === "PENDING").length, 10);
});

test("a numbered batch skips recipients already sent", async () => {
  const recipients = [
    { status: "SENT" },
    { status: "PENDING" },
    { status: "SENT" },
    { status: "PENDING" },
  ];
  const processedIndexes = [];
  const processed = await processBatchItems({
    recipients,
    batchSize: 4,
    recipientIndices: [0, 1, 2, 3],
    processItem: async (index, recipient) => {
      processedIndexes.push(index);
      recipient.status = "SENT";
    },
  });
  assert.equal(processed, 2);
  assert.deepEqual(processedIndexes, [1, 3]);
});

test("slow work stops starting recipients before the request runtime budget is exhausted", async () => {
  const recipients = Array.from({ length: 5 }, () => ({ status: "PENDING" }));
  let elapsed = 0;
  const processed = await processBatchItems({
    recipients,
    batchSize: 5,
    runtimeMs: MAX_BATCH_RUNTIME_MS,
    now: () => elapsed,
    processItem: async (_, recipient) => {
      recipient.status = "SENT";
      elapsed += MAX_BATCH_RUNTIME_MS + 1;
    },
  });
  assert.equal(processed, 1);
  assert.equal(recipients.filter((recipient) => recipient.status === "PENDING").length, 4);
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
    { status: "SENT", attempts: 1, sentAt: new Date(0) },
    { status: "PENDING", nextAttemptAt: new Date(Date.now() + 60_000) },
    { status: "UNKNOWN", attempts: 1 },
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
  assert.deepEqual(processedIndexes, [3]);
  assert.equal(recipients[0].status, "SENT");
  assert.equal(recipients[0].attempts, 1);
  assert.equal(recipients[2].status, "UNKNOWN");
  assert.equal(recipients[2].attempts, 1);
});

test("parallel requests cannot acquire the same active worker lease", async () => {
  let activeLease = null;
  const model = {
    async findOneAndUpdate(_filter, update) {
      if (activeLease && activeLease.workerLeaseUntil > new Date(1000)) return null;
      activeLease = {
        workerLeaseId: update.$set.workerLeaseId,
        workerLeaseUntil: update.$set.workerLeaseUntil,
      };
      return activeLease;
    },
  };
  const options = {
    filter: { _id: "job-worker" },
    now: new Date(1000),
    leaseMs: 90_000,
    idField: "workerLeaseId",
    untilField: "workerLeaseUntil",
  };
  const claims = await Promise.all([
    claimLease(model, { ...options, leaseId: "request-a" }),
    claimLease(model, { ...options, leaseId: "request-b" }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test("an expired worker lease can be claimed again", async () => {
  let activeLease = { workerLeaseId: "expired", workerLeaseUntil: new Date(500) };
  const model = {
    async findOneAndUpdate(_filter, update) {
      if (activeLease && activeLease.workerLeaseUntil > new Date(1000)) return null;
      activeLease = {
        workerLeaseId: update.$set.workerLeaseId,
        workerLeaseUntil: update.$set.workerLeaseUntil,
      };
      return activeLease;
    },
  };
  const lease = await claimLease(model, {
    filter: { _id: "job-worker" },
    leaseId: "recovered",
    now: new Date(1000),
    leaseMs: 90_000,
    idField: "workerLeaseId",
    untilField: "workerLeaseUntil",
  });
  assert.equal(lease.workerLeaseId, "recovered");
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

test("unleased jobs with eligible pending work return to PENDING, not RUNNING", () => {
  assert.equal(
    getUnleasedJobStatus({ pendingCount: 2, processingCount: 0 }, true),
    "PENDING"
  );
  assert.equal(
    getUnleasedJobStatus({ pendingCount: 1, processingCount: 0 }, false),
    "RETRY_WAIT"
  );
  assert.equal(
    getUnleasedJobStatus({ pendingCount: 0, processingCount: 0, successfulCount: 1, failedCount: 0, unknownCount: 0 }, false),
    "COMPLETED"
  );
});

test("pre-delivery 429, 5xx, and network failures are safe transient retries", () => {
  assert.equal(classifyDeliveryError({ status: 429 }).kind, "transient");
  assert.equal(classifyDeliveryError({ status: 503 }).kind, "transient");
  assert.equal(classifyDeliveryError({ cause: { code: "ECONNRESET" } }).kind, "transient");
  assert.equal(classifyDeliveryError({ name: "TimeoutError" }).kind, "transient");
});

test("permanent pre-delivery client errors are not retried", () => {
  assert.deepEqual(classifyDeliveryError({ status: 400 }), { kind: "permanent", retryable: false });
});

test("SMTP errors after delivery starts remain unknown to prevent duplicate emails", () => {
  assert.deepEqual(
    classifyDeliveryError({ responseCode: 450 }, true),
    { kind: "unknown", retryable: false }
  );

  assert.deepEqual(
    classifyDeliveryError({ responseCode: 550 }, true),
    { kind: "unknown", retryable: false }
  );
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
