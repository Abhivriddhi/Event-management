import crypto from "crypto";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import OperationJob from "@/lib/models/OperationJob";
import { runJobBatch } from "@/lib/services/jobService";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || !token) return false;
  const expected = Buffer.from(secret);
  const provided = Buffer.from(token);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export async function GET(req) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ message: "Scheduled job processing is not configured." }, { status: 500 });
  }
  if (!authorized(req)) return NextResponse.json({ message: "Unauthorized." }, { status: 401 });

  try {
    await dbConnect();
    const now = new Date();
    const job = await OperationJob.findOne({
      status: { $in: ["PENDING", "RUNNING", "RETRY_WAIT"] },
      $and: [
        { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      ],
    }).sort({ createdAt: 1 });
    if (!job) return NextResponse.json({ processed: false });

    let result = job;
    let batches = 0;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && ["PENDING", "RUNNING"].includes(result.status)) {
      const previousProcessedCount = result.processedCount;
      result = await runJobBatch(job._id);
      batches++;
      if (
        result.processedCount === previousProcessedCount
        && result.leaseUntil
        && result.leaseUntil > new Date()
      ) break;
    }
    return NextResponse.json({
      processed: true,
      jobId: String(result._id),
      status: result.status,
      batches,
      processedCount: result.processedCount,
      recipientCount: result.recipientCount,
    });
  } catch (error) {
    console.error("Scheduled job processing failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Scheduled job processing failed." }, { status: 500 });
  }
}
