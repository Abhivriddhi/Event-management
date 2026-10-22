import mongoose from "mongoose";

const JobRecipientSchema = new mongoose.Schema(
  {
    recipientKey: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true },
    participant: { type: mongoose.Schema.Types.Mixed, default: {} },
    ticketId: { type: String, default: "" },
    ticketColor: { type: String, enum: ["", "red", "blue"], default: "" },
    templateUrl: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "SENDING", "SENT", "FAILED", "UNKNOWN"],
      default: "PENDING",
    },
    attempts: { type: Number, default: 0 },
    automaticRetries: { type: Number, default: 0 },
    retryable: { type: Boolean, default: false },
    nextAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    temporaryFileIds: { type: [String], default: [] },
    cleanupWarning: { type: String, default: "" },
    sentAt: { type: Date, default: null },
    deliveryStartedAt: { type: Date, default: null },
  },
  { _id: false }
);

const OperationJobSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, index: true },
    type: { type: String, enum: ["ticket", "certificate", "email", "legacy_ticket"], required: true },
    status: {
      type: String,
      enum: ["PENDING", "RUNNING", "RETRY_WAIT", "COMPLETED", "PARTIAL", "FAILED"],
      default: "PENDING",
      index: true,
    },
    subject: { type: String, default: "" },
    html: { type: String, default: "" },
    otherAttachment: {
      filename: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      content: { type: Buffer, default: null },
    },
    templateUrl: { type: String, default: "" },
    attachmentKind: { type: String, enum: ["", "ticket", "certificate"], default: "" },
    deliveryMode: { type: String, enum: ["event", "legacy-image"], default: "event" },
    legacyTicket: {
      eventFilter: { type: String, default: "" },
      qrX: { type: Number, default: 0 },
      qrY: { type: Number, default: 0 },
      qrSize: { type: Number, default: 150 },
    },
    idempotencyKey: { type: String, default: undefined },
    batchSize: { type: Number, default: 5, min: 1, max: 10 },
    currentBatch: { type: Number, default: 1 },
    recipientCount: { type: Number, default: 0 },
    processedCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    processingCount: { type: Number, default: 0 },
    successfulCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    unknownCount: { type: Number, default: 0 },
    nextIndex: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    delayMs: { type: Number, default: 1000 },
    leaseId: { type: String, default: "" },
    leaseUntil: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    recipients: { type: [JobRecipientSchema], default: [] },
  },
  { timestamps: true }
);

OperationJobSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
OperationJobSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export default mongoose.models.OperationJob ||
  mongoose.model("OperationJob", OperationJobSchema);
