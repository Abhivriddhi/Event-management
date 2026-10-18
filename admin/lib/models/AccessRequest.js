import mongoose from "mongoose";

const AccessRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: {
      type: String,
      required() { return this.status === "pending"; },
      select: false,
    },
    message: { type: String, default: "", trim: true, maxlength: 1000 },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", required: true },
    assignedRole: { type: String, enum: ["super_admin", "admin", "qr_admin"], default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.models.AccessRequest ||
  mongoose.model("AccessRequest", AccessRequestSchema);
