import mongoose from "mongoose";

const EmailRateLimitSchema = new mongoose.Schema({
  _id: { type: String, default: "smtp" },
  nextAllowedAt: { type: Date, default: null },
  workerLeaseId: { type: String, default: "" },
  workerLeaseUntil: { type: Date, default: null },
});

export default mongoose.models.EmailRateLimit ||
  mongoose.model("EmailRateLimit", EmailRateLimitSchema);
