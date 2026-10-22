export const DEFAULT_BATCH_SIZE = 5;
export const MAX_BATCH_SIZE = 5;
export const MAX_AUTOMATIC_RETRIES = 4;
export const JOB_LEASE_MS = 90_000;
export const MAX_BATCH_RUNTIME_MS = 5_000;

export function parseBatchSize(value = DEFAULT_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`Batch size must be an integer between 1 and ${MAX_BATCH_SIZE} until larger batches are verified safe.`);
  }
  return batchSize;
}

export function effectiveBatchSize(value = DEFAULT_BATCH_SIZE) {
  const batchSize = Number(value);
  return Number.isInteger(batchSize) && batchSize > 0
    ? Math.min(batchSize, MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;
}

export function claimLease(model, {
  filter,
  leaseId,
  now,
  leaseMs,
  idField = "leaseId",
  untilField = "leaseUntil",
}) {
  return model.findOneAndUpdate(
    {
      ...filter,
      $or: [{ [untilField]: null }, { [untilField]: { $lte: now } }],
    },
    {
      $set: {
        [idField]: leaseId,
        [untilField]: new Date(now.getTime() + leaseMs),
      },
    },
    { new: true }
  );
}

export function splitIntoBatches(count, batchSize) {
  const size = parseBatchSize(batchSize);
  if (!Number.isInteger(count) || count < 0) throw new Error("Recipient count must be a non-negative integer.");
  return Array.from({ length: Math.ceil(count / size) }, (_, batch) =>
    Array.from({ length: Math.min(size, count - batch * size) }, (__, offset) => batch * size + offset)
  );
}

export async function processBatchItems({
  recipients,
  batchSize,
  processItem,
  now = Date.now,
  runtimeMs = MAX_BATCH_RUNTIME_MS,
  shouldContinue = () => true,
}) {
  const size = effectiveBatchSize(batchSize);
  const startedAt = now();
  let processedCount = 0;
  while (processedCount < size && now() - startedAt < runtimeMs && shouldContinue()) {
    const currentTime = new Date(now());
    const index = recipients.findIndex((recipient) =>
      recipient.status === "PENDING"
      && (!recipient.nextAttemptAt || recipient.nextAttemptAt <= currentTime)
    );
    if (index < 0) break;
    await processItem(index, recipients[index]);
    processedCount++;
  }
  return processedCount;
}

export function countJobRecipients(recipients = []) {
  return recipients.reduce((counts, recipient) => {
    switch (recipient.status) {
      case "SENT":
        counts.successfulCount++;
        break;
      case "FAILED":
        counts.failedCount++;
        break;
      case "UNKNOWN":
        counts.unknownCount++;
        break;
      case "PROCESSING":
      case "SENDING":
        counts.processingCount++;
        break;
      default:
        counts.pendingCount++;
    }
    return counts;
  }, {
    pendingCount: 0,
    processingCount: 0,
    successfulCount: 0,
    failedCount: 0,
    unknownCount: 0,
  });
}

export function shouldAutomaticallyRetry(classification, automaticRetries) {
  return classification.kind === "transient" && automaticRetries < MAX_AUTOMATIC_RETRIES;
}

export function recoverExpiredRecipient(recipient) {
  if (recipient.status === "PROCESSING") {
    return {
      ...recipient,
      status: "PENDING",
      lastError: "Worker lease expired during preparation; safely resuming.",
    };
  }
  if (recipient.status === "SENDING") {
    return {
      ...recipient,
      status: "UNKNOWN",
      retryable: false,
      lastError: "Worker lease expired after delivery began; verify provider delivery before resending.",
    };
  }
  return recipient;
}

export function getTerminalJobStatus(counts) {
  if (counts.pendingCount || counts.processingCount) return null;
  if (counts.failedCount || counts.unknownCount) return counts.successfulCount ? "PARTIAL" : "FAILED";
  return "COMPLETED";
}

export function getUnleasedJobStatus(counts, eligiblePending) {
  return getTerminalJobStatus(counts) || (eligiblePending ? "PENDING" : "RETRY_WAIT");
}

export function classifyDeliveryError(error, deliveryStarted = false) {
  const responseCode = Number(error?.responseCode);
  const status = Number(error?.status || error?.statusCode);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();

  if (deliveryStarted) {
    return { kind: "unknown", retryable: false };
  }

  if (error?.retryable === true) return { kind: "transient", retryable: true };
  if (status === 429 || (status >= 500 && status < 600)) {
    return { kind: "transient", retryable: true };
  }
  if ([
    "ECONNECTION",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ESOCKET",
    "EAI_AGAIN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code)) {
    return { kind: "transient", retryable: true };
  }
  if (["AbortError", "TimeoutError"].includes(String(error?.name || ""))) {
    return { kind: "transient", retryable: true };
  }
  if (status >= 400) return { kind: "permanent", retryable: false };
  return { kind: "permanent", retryable: false };
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function getRetryDelayMs(retryCount, retryAfterMs = 0, random = Math.random) {
  const exponential = Math.min(300_000, 5_000 * (2 ** Math.max(0, retryCount - 1)));
  const jittered = exponential + Math.floor(exponential * 0.25 * random());
  return Math.max(jittered, Math.min(86_400_000, Math.max(0, retryAfterMs)));
}

export function getSafeErrorMessage(error) {
  const message = String(error?.message || "Delivery failed.")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return message.slice(0, 400) || "Delivery failed.";
}
