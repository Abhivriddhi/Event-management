import crypto from "crypto";
import Event from "@/lib/models/Event";
import OperationJob from "@/lib/models/OperationJob";
import Ticket from "@/lib/models/Ticket";
import User from "@/lib/models/User";
import EmailRateLimit from "@/lib/models/EmailRateLimit";
import sharp from "sharp";
import QRCode from "qrcode";
import {
  createPersonalizedPdf,
  validateSlidesTemplate,
} from "@/lib/services/slidesTemplateService";
import { loadEventParticipants } from "@/lib/services/participantSourceService";
import { issueTicket, ticketColor } from "@/lib/services/ticketService";
import { renderHtmlTemplate, sendPersonalizedEmail } from "@/lib/services/emailService";
import { deleteDriveFile } from "@/lib/services/googleApi";
import {
  getTemplateTokens,
  renderTemplate,
  validateTemplateValues,
} from "@/lib/services/templateEngine";
import {
  countJobRecipients,
  classifyDeliveryError,
  claimLease,
  DEFAULT_BATCH_SIZE,
  effectiveBatchSize,
  getRetryDelayMs,
  getSafeErrorMessage,
  getUnleasedJobStatus,
  JOB_LEASE_MS,
  parseBatchSize,
  parseRetryAfter,
  processBatchItems,
  recoverExpiredRecipient,
  shouldAutomaticallyRetry,
  getTerminalJobStatus,
} from "@/lib/services/jobQueueUtils";

function getParticipantPaths(value, prefix = "participant") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => getParticipantPaths(item, `${prefix}.${key}`));
}

function getEmailContext(participant, event, ticketId = "") {
  return {
    participant,
    event: { name: event.name },
    ticket: { id: ticketId },
  };
}

function getRecipientKey(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
}

export async function createOperationJob({
  eventId,
  type,
  subject,
  html,
  attachmentKind = "",
  otherAttachment = null,
  batchSize = DEFAULT_BATCH_SIZE,
  idempotencyKey = "",
}) {
  if (!["ticket", "certificate", "email"].includes(type)) throw new Error("Unsupported operation type.");
  const validBatchSize = parseBatchSize(batchSize);
  if (idempotencyKey) {
    const existing = await OperationJob.findOne({ idempotencyKey });
    if (existing) return existing;
  }
  const event = await Event.findOne({ eventId: String(eventId).toLowerCase() });
  if (!event) throw new Error("Event not found.");
  if ((type === "ticket" || type === "certificate") && !event.emailSettings?.enabled) {
    throw new Error("Email sending is disabled for this event.");
  }
  if (type === "ticket" && !event.ticketSettings?.enabled) {
    throw new Error("Ticket issuance is disabled for this event.");
  }
  if (type === "email" && !event.emailSettings?.enabled) {
    throw new Error("Email sending is disabled for this event.");
  }
  if (type === "email" && attachmentKind === "ticket" && !event.ticketSettings?.enabled) {
    throw new Error("Ticket issuance is disabled for this event.");
  }

  const participants = await loadEventParticipants(event);
  const unique = new Map();
  for (const participant of participants) {
    if (!participant.email) throw new Error("Every participant must have a mapped email address.");
    if (!unique.has(participant.email)) unique.set(participant.email, participant);
  }
  const recipients = [...unique.values()];
  if (!recipients.length) throw new Error("The selected source contains no participants.");
  if (attachmentKind && !["ticket", "certificate"].includes(attachmentKind)) {
    throw new Error("Choose a supported PDF attachment type.");
  }

  const emailSubject = String(subject ?? event.emailTemplate?.subject ?? "").trim();
  const emailHtml = String(html ?? event.emailTemplate?.html ?? "");
  if (!emailSubject || !emailHtml) throw new Error("Email subject and HTML body are required.");

  if (type === "ticket" && !process.env.TICKET_SAUCE) {
    throw new Error("TICKET_SAUCE is not configured on the server.");
  }

  const willHaveTicket = type === "ticket" || (type === "email" && attachmentKind === "ticket");
  if (willHaveTicket) {
    const seenPrns = new Set();
    for (const participant of recipients) {
      const normalizedPrn = String(participant.prn || "").trim().toUpperCase();
      if (!normalizedPrn) throw new Error(`Mapped PRN is required for ticket recipient ${participant.email}.`);
      if (seenPrns.has(normalizedPrn)) throw new Error(`PRN ${participant.prn} is assigned to more than one participant.`);
      seenPrns.add(normalizedPrn);
    }
  }

  const sample = recipients[0];
  const validationTicketId = willHaveTicket ? "VALIDATION-TICKET-ID" : "";
  const sampleContext = getEmailContext(sample, event, validationTicketId);
  const emailPaths = new Set(getParticipantPaths(sample));
  const mayUseExistingTicketId = type === "certificate" || (type === "email" && attachmentKind === "certificate");
  const validEmailTokens = new Set([
    ...emailPaths,
    "event.name",
    ...(willHaveTicket || mayUseExistingTicketId ? ["ticket.id"] : []),
  ]);
  const usedEmailTokens = getTemplateTokens(`${emailSubject}\n${emailHtml}`);
  const invalidEmailTokens = usedEmailTokens.filter((token) => !validEmailTokens.has(token));
  if (invalidEmailTokens.length) {
    throw new Error(`Email template contains unavailable placeholders: ${[...new Set(invalidEmailTokens)].join(", ")}`);
  }
  validateTemplateValues(`${emailSubject}\n${emailHtml}`, sampleContext, ["participant.name", "event.name"]);
  for (const participant of recipients) {
    const context = getEmailContext(participant, event, validationTicketId);
    renderTemplate(emailSubject, context, { strict: true });
    renderTemplate(emailHtml, context, { strict: true });
  }

  let templateUrl = "";
  let slidesTokenSets = [];
  const ticketTemplateUrls = {
    red: event.ticketTemplates?.red || event.ticketTemplateUrl || "",
    blue: event.ticketTemplates?.blue || event.ticketTemplateUrl || "",
  };
  if (type === "ticket" || (type === "email" && attachmentKind === "ticket")) {
    const context = { ...sampleContext, ticket: { id: validationTicketId, qr: "" } };
    for (const color of ["red", "blue"]) {
      const validation = await validateSlidesTemplate(ticketTemplateUrls[color], context, [
        "participant.name",
        "event.name",
        "ticket.id",
        "ticket.qr",
      ], event.ticketSettings?.qrPlaceholder || "{{ticket.qr}}");
      slidesTokenSets.push(validation.tokens);
    }
  } else if (type === "certificate" || (type === "email" && attachmentKind === "certificate")) {
    templateUrl = event.certificateTemplateUrl;
    const validation = await validateSlidesTemplate(templateUrl, sampleContext, ["participant.name", "event.name"]);
    slidesTokenSets.push(validation.tokens);
  }
  for (const participant of recipients) {
    const context = getEmailContext(participant, event, validationTicketId);
    for (const tokens of slidesTokenSets) renderTemplate(tokens.map((token) => `{{${token}}}`).join(" "), {
      ...context,
      ticket: { ...context.ticket, qr: "" },
    }, { strict: true });
  }

  const job = await createIdempotentJob({
    eventId: event.eventId,
    type,
    subject: emailSubject,
    html: emailHtml,
    otherAttachment: otherAttachment || undefined,
    templateUrl,
    attachmentKind,
    batchSize: validBatchSize,
    currentBatch: 1,
    idempotencyKey: idempotencyKey || undefined,
    recipientCount: recipients.length,
    pendingCount: recipients.length,
    delayMs: Number(event.emailSettings?.delayMs ?? 1000),
    recipients: recipients.map((participant) => ({
      recipientKey: getRecipientKey(participant.email),
      email: participant.email,
      participant,
      status: "PENDING",
    })),
  });
  return job;
}

async function createIdempotentJob(values) {
  try {
    return await OperationJob.create(values);
  } catch (error) {
    if (error.code !== 11000 || !values.idempotencyKey) throw error;
    const existing = await OperationJob.findOne({ idempotencyKey: values.idempotencyKey });
    if (!existing) throw error;
    return existing;
  }
}

export async function createLegacyTicketJob({
  ticketType,
  eventFilter,
  qrX,
  qrY,
  qrSize,
  subject,
  body,
  ticketImage,
  imageType,
  batchSize = DEFAULT_BATCH_SIZE,
  idempotencyKey = "",
}) {
  const validBatchSize = parseBatchSize(batchSize);
  if (!idempotencyKey) throw new Error("An idempotency key is required.");
  const existing = await OperationJob.findOne({ idempotencyKey });
  if (existing) return existing;
  if (!ticketImage?.length) throw new Error("Ticket file is required.");
  if (ticketImage.length > 6 * 1024 * 1024) throw new Error("Ticket file must be smaller than 6 MB.");
  if (![qrX, qrY, qrSize].every(Number.isFinite) || qrX < 0 || qrY < 0 || qrSize < 1) {
    throw new Error("QR position and size must be valid positive pixel values.");
  }
  if (!String(subject || "").trim() || typeof body !== "string") {
    throw new Error("Email subject and body are required.");
  }

  const query = {};
  if (ticketType !== "ALL") query.ticketType = ticketType;
  if (eventFilter !== "ALL") query.registeredEvent = eventFilter;
  const users = await User.find(query).lean();
  if (!users.length) throw new Error("No users found matching the selected filters.");

  const recipients = users.map((user) => ({
    recipientKey: getRecipientKey(user.email),
    email: String(user.email || "").trim().toLowerCase(),
    participant: {
      name: user.name || "",
      prn: user.prn || "",
      email: user.email || "",
      ticketType: user.ticketType || "",
      registeredEvent: Array.isArray(user.registeredEvent) ? user.registeredEvent : [],
    },
    status: "PENDING",
  }));
  return createIdempotentJob({
    eventId: "legacy",
    type: "legacy_ticket",
    deliveryMode: "legacy-image",
    subject: String(subject).trim(),
    html: body,
    otherAttachment: {
      filename: "ticket-template",
      mimeType: imageType || "image/png",
      content: ticketImage,
    },
    legacyTicket: { eventFilter: String(eventFilter), qrX, qrY, qrSize },
    batchSize: validBatchSize,
    currentBatch: 1,
    idempotencyKey,
    recipientCount: recipients.length,
    pendingCount: recipients.length,
    recipients,
  });
}

export async function getJobSummary(jobId) {
  return OperationJob.findById(jobId)
    .select("-recipients.participant -recipients.temporaryFileIds -otherAttachment.content")
    .lean();
}

async function prepareEventDelivery(job, recipient, leaseId, index, event) {
  for (const fileId of [...recipient.temporaryFileIds]) {
    await deleteDriveFile(fileId);
    recipient.temporaryFileIds = recipient.temporaryFileIds.filter((value) => value !== fileId);
  }

  const ticketTemplateUrls = {
    red: event.ticketTemplates?.red || event.ticketTemplateUrl || "",
    blue: event.ticketTemplates?.blue || event.ticketTemplateUrl || "",
  };
  if ((job.type === "ticket" || (job.type === "email" && job.attachmentKind === "ticket")) && !recipient.ticketId) {
    const ticket = await issueTicket({
      eventId: event.eventId,
      eventName: event.name,
      participant: recipient.participant,
    });
    recipient.ticketId = ticket.ticketId;
    recipient.ticketColor = ticket.color;
  }
  if (job.type === "ticket" || (job.type === "email" && job.attachmentKind === "ticket")) {
    recipient.ticketColor ||= ticketColor(recipient.ticketId) || "";
    recipient.templateUrl ||= job.templateUrl || ticketTemplateUrls[recipient.ticketColor];
    if (!recipient.templateUrl) throw new Error(`No ${recipient.ticketColor || "matching"} ticket template is stored for this recipient.`);
    const update = await OperationJob.updateOne(
      { _id: job._id, leaseId, leaseUntil: { $gt: new Date() } },
      {
        $set: {
          [`recipients.${index}.ticketId`]: recipient.ticketId,
          [`recipients.${index}.ticketColor`]: recipient.ticketColor,
          [`recipients.${index}.templateUrl`]: recipient.templateUrl,
          [`recipients.${index}.temporaryFileIds`]: recipient.temporaryFileIds,
        },
      }
    );
    if (!update.matchedCount) throw new Error("Job lease was lost before delivery preparation completed.");
  }

  let ticketId = recipient.ticketId || "";
  const isCertificateDelivery = job.type === "certificate" || (job.type === "email" && job.attachmentKind === "certificate");
  if (isCertificateDelivery && !ticketId && recipient.participant.prn) {
    const ticket = await Ticket.findOne({
      eventId: event.eventId,
      prn: recipient.participant.prn,
    }).select("ticketId").lean();
    ticketId = ticket?.ticketId || "";
  }
  const context = getEmailContext(recipient.participant, event, ticketId);
  const attachments = job.otherAttachment?.content
    ? [{
        filename: job.otherAttachment.filename || "attachment",
        content: job.otherAttachment.content,
        contentType: job.otherAttachment.mimeType || "application/octet-stream",
      }]
    : [];
  let cleanupWarning = "";

  if (job.type === "ticket" || (job.type === "email" && job.attachmentKind === "ticket")) {
    const generated = await createPersonalizedPdf({
      templateUrl: recipient.templateUrl,
      context: { ...context, ticket: { id: recipient.ticketId, qr: "" } },
      qrPlaceholder: event.ticketSettings?.qrPlaceholder || "{{ticket.qr}}",
      requireTicketId: true,
      onTemporaryFile: async (fileId, removed = false) => {
        const filter = {
          _id: job._id,
          leaseId,
          [`recipients.${index}.status`]: "PROCESSING",
        };
        const update = removed
          ? { $pull: { [`recipients.${index}.temporaryFileIds`]: fileId } }
          : { $addToSet: { [`recipients.${index}.temporaryFileIds`]: fileId } };
        await OperationJob.updateOne(filter, update);
      },
    });
    cleanupWarning = generated.cleanupWarnings.join("; ");
    attachments.push({ filename: "ticket.pdf", content: generated.pdf, contentType: "application/pdf" });
  } else if (job.type === "certificate" || (job.type === "email" && job.attachmentKind === "certificate")) {
    const generated = await createPersonalizedPdf({
      templateUrl: job.templateUrl,
      context,
      requireTicketId: false,
      onTemporaryFile: async (fileId, removed = false) => {
        const filter = {
          _id: job._id,
          leaseId,
          [`recipients.${index}.status`]: "PROCESSING",
        };
        const update = removed
          ? { $pull: { [`recipients.${index}.temporaryFileIds`]: fileId } }
          : { $addToSet: { [`recipients.${index}.temporaryFileIds`]: fileId } };
        await OperationJob.updateOne(filter, update);
      },
    });
    cleanupWarning = generated.cleanupWarnings.join("; ");
    attachments.push({ filename: "certificate.pdf", content: generated.pdf, contentType: "application/pdf" });
  }
  return { context, attachments, cleanupWarning };
}

async function prepareLegacyTicketDelivery(job, recipient) {
  const participant = recipient.participant;
  const qrData = `Name:${participant.name}\nPRN:${participant.prn || ""}\nEmail:${participant.email}\nTicketType:${participant.ticketType}`;
  const qrBuffer = await QRCode.toBuffer(qrData, { width: job.legacyTicket.qrSize });
  const ticketWithQR = await sharp(job.otherAttachment.content)
    .composite([{
      input: await sharp(qrBuffer).resize(job.legacyTicket.qrSize, job.legacyTicket.qrSize).toBuffer(),
      left: job.legacyTicket.qrX,
      top: job.legacyTicket.qrY,
    }])
    .png()
    .toBuffer();
  const eventName = job.legacyTicket.eventFilter === "ALL"
    ? participant.registeredEvent?.join(", ")
    : job.legacyTicket.eventFilter;
  const html = job.html
    .replace(/{name}/g, participant.name)
    .replace(/{event}/g, eventName)
    .replace(/{ticketType}/g, participant.ticketType)
    .replace(/\n/g, "<br>");
  return {
    context: {},
    html,
    attachments: [{ filename: "ticket.png", content: ticketWithQR, contentType: "image/png" }],
  };
}

async function updateRecipient(jobId, leaseId, index, status, values = {}, increments = {}) {
  const update = {
    $set: {
      [`recipients.${index}.status`]: status,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`recipients.${index}.${key}`, value])),
    },
  };
  if (Object.keys(increments).length) {
    update.$inc = Object.fromEntries(Object.entries(increments).map(([key, value]) => [`recipients.${index}.${key}`, value]));
  }
  const result = await OperationJob.updateOne(
    { _id: jobId, leaseId, leaseUntil: { $gt: new Date() } },
    update
  );
  if (!result.matchedCount) throw new Error("Job lease was lost while updating recipient progress.");
}

async function processRecipient(job, leaseId, index, event) {
  const recipient = job.recipients[index];
  const startedAt = new Date();
  recipient.status = "PROCESSING";
  recipient.attempts = (recipient.attempts || 0) + 1;
  recipient.lastAttemptAt = startedAt;
  await updateRecipient(job._id, leaseId, index, "PROCESSING", {
    attempts: recipient.attempts,
    lastAttemptAt: startedAt,
    lastError: "",
    nextAttemptAt: null,
    retryable: false,
  });

  let delivery;
  try {
    if (!/^\S+@\S+\.\S+$/.test(recipient.email)) {
      throw new Error("Recipient email address is missing or invalid.");
    }
    delivery = job.deliveryMode === "legacy-image"
      ? await prepareLegacyTicketDelivery(job, recipient)
      : await prepareEventDelivery(job, recipient, leaseId, index, event);
  } catch (error) {
    await recordDeliveryFailure(job, leaseId, index, error, false);
    return;
  }

  const deliveryStartedAt = new Date();
  let deliveryStarted = false;
  try {
    await sendPersonalizedEmail({
      to: recipient.email,
      subject: job.subject,
      html: delivery.html ?? job.html,
      context: delivery.context,
      attachments: delivery.attachments,
      dailyLimit: event?.emailSettings?.dailyLimit,
      delayMs: job.delayMs,
      onDeliveryStart: async () => {
        await updateRecipient(job._id, leaseId, index, "SENDING", { deliveryStartedAt });
        recipient.status = "SENDING";
        deliveryStarted = true;
      },
    });
    await updateRecipient(job._id, leaseId, index, "SENT", {
      sentAt: new Date(),
      lastError: "",
      retryable: false,
      nextAttemptAt: null,
      cleanupWarning: delivery.cleanupWarning || "",
    });
    recipient.status = "SENT";
  } catch (error) {
    await recordDeliveryFailure(job, leaseId, index, error, deliveryStarted);
  }
}

async function recordDeliveryFailure(job, leaseId, index, error, deliveryStarted) {
  const retry = classifyDeliveryError(error, deliveryStarted);
  const recipient = job.recipients[index];
  const automaticRetries = recipient.automaticRetries || 0;
  const canRetry = shouldAutomaticallyRetry(retry, automaticRetries);
  const message = getSafeErrorMessage(error);

  if (canRetry) {
    const retryCount = automaticRetries + 1;
    const retryAfterMs = error.retryAfterMs || parseRetryAfter(error.retryAfter);
    const nextAttemptAt = new Date(Date.now() + getRetryDelayMs(retryCount, retryAfterMs));
    recipient.status = "PENDING";
    recipient.automaticRetries = retryCount;
    recipient.retryable = true;
    recipient.nextAttemptAt = nextAttemptAt;
    recipient.lastError = message;
    await updateRecipient(job._id, leaseId, index, "PENDING", {
      automaticRetries: retryCount,
      retryable: true,
      nextAttemptAt,
      lastError: message,
    });
    return;
  }

  if (retry.kind === "unknown") {
    recipient.status = "UNKNOWN";
    recipient.retryable = false;
    recipient.lastError = `Delivery outcome unknown; verify before resending. ${message}`;
    await updateRecipient(job._id, leaseId, index, "UNKNOWN", {
      retryable: false,
      lastError: recipient.lastError,
    });
    return;
  }

  recipient.status = "FAILED";
  recipient.retryable = retry.retryable;
  recipient.lastError = message;
  await updateRecipient(job._id, leaseId, index, "FAILED", {
    retryable: retry.retryable,
    lastError: message,
    nextAttemptAt: null,
  });
}

export async function runJobBatch(jobId, batchNumber = null) {
  if (batchNumber !== null) {
    if (!Number.isInteger(batchNumber) || batchNumber < 1) {
      const error = new Error("Batch number must be a positive integer.");
      error.status = 400;
      throw error;
    }
    const jobDetails = await OperationJob.findById(jobId).select("recipientCount batchSize");
    if (!jobDetails) throw new Error("Job not found.");
    const batchCount = Math.ceil(jobDetails.recipientCount / effectiveBatchSize(jobDetails.batchSize));
    if (batchNumber > batchCount) {
      const error = new Error("Batch number is outside this job's recipient range.");
      error.status = 400;
      throw error;
    }
  }

  const workerLeaseId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const now = new Date();
  try {
    await EmailRateLimit.updateOne(
      { _id: "job-worker" },
      { $setOnInsert: { nextAllowedAt: null, workerLeaseId: "", workerLeaseUntil: null } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const workerLease = await claimLease(EmailRateLimit, {
    filter: { _id: "job-worker" },
    leaseId: workerLeaseId,
    now,
    leaseMs: JOB_LEASE_MS,
    idField: "workerLeaseId",
    untilField: "workerLeaseUntil",
  });
  if (!workerLease) {
    const current = await OperationJob.findById(jobId);
    if (!current) throw new Error("Job not found.");
    const error = new Error("Another job batch is currently processing. Refresh progress before trying again.");
    error.status = 409;
    throw error;
  }
  try {
    return await runLeasedJobBatch(jobId, workerLeaseId, leaseId, batchNumber);
  } catch (error) {
    await recoverInterruptedBatch(jobId, leaseId, error);
    throw error;
  } finally {
    await EmailRateLimit.updateOne(
      { _id: "job-worker", workerLeaseId },
      { $set: { workerLeaseId: "", workerLeaseUntil: null } }
    );
  }
}

async function recoverInterruptedBatch(jobId, leaseId, error) {
  const now = new Date();
  const retryAt = new Date(now.getTime() + 30_000);
  const result = await OperationJob.updateOne(
    { _id: jobId, status: "RUNNING", leaseId },
    {
      $set: {
        status: "RETRY_WAIT",
        nextAttemptAt: retryAt,
        lastError: getSafeErrorMessage(error),
        "recipients.$[sending].status": "UNKNOWN",
        "recipients.$[sending].retryable": false,
        "recipients.$[sending].lastError": "Worker stopped after delivery began; verify provider delivery before resending.",
        "recipients.$[processing].status": "PENDING",
        leaseId: "",
        leaseUntil: null,
      },
    },
    {
      arrayFilters: [
        { "sending.status": "SENDING" },
        { "processing.status": "PROCESSING" },
      ],
    }
  );
  if (!result.matchedCount) return;

  const job = await OperationJob.findById(jobId);
  if (!job) return;
  const counts = countJobRecipients(job.recipients);
  const processedCount = counts.successfulCount + counts.failedCount + counts.unknownCount;
  const terminalStatus = getTerminalJobStatus(counts);
  await OperationJob.updateOne(
    { _id: jobId, status: "RETRY_WAIT", leaseId: "" },
    {
      $set: {
        ...counts,
        processedCount,
        status: terminalStatus || "RETRY_WAIT",
        completedAt: terminalStatus ? now : null,
      },
    }
  );
}

async function runLeasedJobBatch(jobId, workerLeaseId, leaseId, batchNumber = null) {
  const now = new Date();
  const job = await claimLease(OperationJob, {
    filter: {
      _id: jobId,
      status: { $in: ["PENDING", "RUNNING", "RETRY_WAIT"] },
      $and: [{ $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }],
    },
    leaseId,
    now,
    leaseMs: JOB_LEASE_MS,
  });

  if (!job) {
    const current = await OperationJob.findById(jobId);
    if (!current) throw new Error("Job not found.");
    if (["PENDING", "RUNNING", "RETRY_WAIT"].includes(current.status)) {
      const error = new Error("This job is already being processed or is waiting for its retry time.");
      error.status = 409;
      throw error;
    }
    return current;
  }

  if (!job.startedAt) job.startedAt = now;
  job.recipients = job.recipients.map(recoverExpiredRecipient);
  await job.save();

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    Promise.all([
      OperationJob.updateOne(
        { _id: job._id, leaseId },
        { $set: { leaseUntil: new Date(Date.now() + JOB_LEASE_MS) } }
      ),
      EmailRateLimit.updateOne(
        { _id: "job-worker", workerLeaseId },
        { $set: { workerLeaseUntil: new Date(Date.now() + JOB_LEASE_MS) } }
      ),
    ]).then((results) => {
      if (results.some((result) => !result.matchedCount)) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, Math.floor(JOB_LEASE_MS / 3));
  heartbeat.unref?.();

  let event = null;
  let batchError = null;
  try {
    if (job.deliveryMode !== "legacy-image") {
      event = await Event.findOne({ eventId: job.eventId });
      if (!event) throw new Error("Event no longer exists.");
    }

    const batchSize = effectiveBatchSize(job.batchSize);
    const startIndex = batchNumber === null ? 0 : (batchNumber - 1) * batchSize;
    const recipientIndices = batchNumber === null
      ? undefined
      : Array.from(
        { length: Math.max(0, Math.min(batchSize, job.recipients.length - startIndex)) },
        (_, offset) => startIndex + offset
      );
    await processBatchItems({
      recipients: job.recipients,
      batchSize,
      recipientIndices,
      processItem: (index) => processRecipient(job, leaseId, index, event),
      shouldContinue: () => !leaseLost,
    });
  } catch (error) {
    batchError = error;
  } finally {
    clearInterval(heartbeat);
  }

  const latest = await OperationJob.findOne({ _id: job._id, leaseId });
  if (!latest) return OperationJob.findById(job._id);
  if (batchError) {
    await recoverInterruptedBatch(latest._id, leaseId, batchError);
    return OperationJob.findById(latest._id);
  }
  const counts = countJobRecipients(latest.recipients);
  const pendingRecipients = latest.recipients.filter((recipient) => recipient.status === "PENDING");
  const eligiblePending = pendingRecipients.some((recipient) => !recipient.nextAttemptAt || recipient.nextAttemptAt <= new Date());
  const nextAttemptAt = pendingRecipients
    .map((recipient) => recipient.nextAttemptAt)
    .filter(Boolean)
    .sort((left, right) => left - right)[0] || null;
  const processedCount = counts.successfulCount + counts.failedCount + counts.unknownCount;
  const currentBatchSize = effectiveBatchSize(latest.batchSize);
  const nextRecipientIndex = latest.recipients.findIndex((recipient) =>
    ["PENDING", "PROCESSING", "SENDING"].includes(recipient.status)
  );
  const currentBatch = nextRecipientIndex < 0
    ? Math.max(1, Math.ceil(latest.recipientCount / currentBatchSize))
    : Math.floor(nextRecipientIndex / currentBatchSize) + 1;
  const terminalStatus = getTerminalJobStatus(counts);
  const terminal = Boolean(terminalStatus);
  const status = getUnleasedJobStatus(counts, eligiblePending);
  await OperationJob.updateOne(
    { _id: latest._id, leaseId },
    {
      $set: {
        ...counts,
        processedCount,
        currentBatch,
        nextAttemptAt: eligiblePending ? null : nextAttemptAt,
        status,
        lastError: "",
        completedAt: terminal ? new Date() : null,
        leaseId: "",
        leaseUntil: null,
      },
    }
  );
  return OperationJob.findById(latest._id);
}

export async function runJobItem(jobId) {
  return runJobBatch(jobId);
}

export async function retryFailedRecipients(jobId) {
  const now = new Date();
  const job = await OperationJob.findOneAndUpdate(
    {
      _id: jobId,
      status: { $in: ["PARTIAL", "FAILED"] },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      recipients: { $elemMatch: { status: "FAILED", retryable: true } },
    },
    {
      $set: {
        "recipients.$[recipient].status": "PENDING",
        "recipients.$[recipient].lastError": "",
        "recipients.$[recipient].nextAttemptAt": null,
        "recipients.$[recipient].automaticRetries": 0,
        status: "PENDING",
        nextAttemptAt: null,
        completedAt: null,
      },
    },
    {
      new: true,
      arrayFilters: [{ "recipient.status": "FAILED", "recipient.retryable": true }],
    }
  );
  if (!job) {
    const exists = await OperationJob.exists({ _id: jobId });
    if (!exists) throw new Error("Job not found.");
    throw new Error("This job has no safely retryable failed recipients, or is currently leased.");
  }

  const counts = countJobRecipients(job.recipients);
  const processedCount = counts.successfulCount + counts.failedCount + counts.unknownCount;
  await OperationJob.updateOne(
    { _id: job._id, status: "PENDING", leaseUntil: null },
    {
      $set: {
        ...counts,
        processedCount,
        nextIndex: job.recipients.findIndex((recipient) => recipient.status === "PENDING"),
      },
    }
  );
  return OperationJob.findById(job._id);
}

export async function testEventEmail({ eventId, to, subject, html }) {
  const event = await Event.findOne({ eventId: String(eventId).toLowerCase() });
  if (!event) throw new Error("Event not found.");
  const [participant] = await loadEventParticipants(event);
  if (!participant) throw new Error("The configured participant source contains no rows.");
  const ticket = participant.prn ? await Ticket.findOne({ eventId: event.eventId, prn: participant.prn }) : null;
  const context = getEmailContext(participant, event, ticket?.ticketId || "");
  validateTemplateValues(`${subject}\n${html}`, context, ["participant.name", "event.name"]);
  await sendPersonalizedEmail({
    to,
    subject,
    html,
    context,
    dailyLimit: event.emailSettings?.dailyLimit,
    delayMs: event.emailSettings?.delayMs,
  });
}

export async function previewEventEmail({ eventId, subject, html }) {
  const event = await Event.findOne({ eventId: String(eventId).toLowerCase() });
  if (!event) throw new Error("Event not found.");
  const [participant] = await loadEventParticipants(event);
  if (!participant) throw new Error("The configured participant source contains no rows.");
  const ticket = participant.prn ? await Ticket.findOne({ eventId: event.eventId, prn: participant.prn }) : null;
  const context = getEmailContext(participant, event, ticket?.ticketId || "SAMPLE-TICKET-ID");
  validateTemplateValues(`${subject}\n${html}`, context, ["participant.name", "event.name"]);
  return {
    subject: renderTemplate(subject, context),
    html: renderHtmlTemplate(html, context),
  };
}
