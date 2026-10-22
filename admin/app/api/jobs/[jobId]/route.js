import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import OperationJob from "@/lib/models/OperationJob";
import { requireAdmin } from "@/lib/auth";
import { getJobSummary, retryFailedRecipients, runJobBatch } from "@/lib/services/jobService";
import { deleteDriveFile } from "@/lib/services/googleApi";
import { getSafeErrorMessage } from "@/lib/services/jobQueueUtils";

export const runtime = "nodejs";
export const maxDuration = 60;

function publicJob(job) {
  return {
    _id: job._id,
    type: job.type,
    status: job.status,
    batchSize: job.batchSize,
    currentBatch: job.currentBatch,
    recipientCount: job.recipientCount,
    processedCount: job.processedCount,
    pendingCount: job.pendingCount,
    processingCount: job.processingCount,
    successfulCount: job.successfulCount,
    failedCount: job.failedCount,
    unknownCount: job.unknownCount,
    leaseUntil: job.leaseUntil,
    nextAttemptAt: job.nextAttemptAt,
    lastError: job.lastError,
    retryableCount: (job.recipients || []).filter((recipient) => recipient.status === "FAILED" && recipient.retryable).length,
    recipients: (job.recipients || []).map((recipient) => ({
      email: recipient.email,
      status: recipient.status,
      attempts: recipient.attempts,
      retryable: recipient.retryable,
      lastError: recipient.lastError,
      nextAttemptAt: recipient.nextAttemptAt,
    })),
  };
}

export async function GET(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { jobId } = await params;
  const job = await getJobSummary(jobId);
  if (!job) return NextResponse.json({ message: "Job not found." }, { status: 404 });
  return NextResponse.json({ job });
}

export async function POST(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { jobId } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "retry") {
      const job = await retryFailedRecipients(jobId);
      return NextResponse.json({ job: publicJob(job) });
    } else if (body.action === "cleanup") {
      const job = await OperationJob.findById(jobId);
      if (!job) return NextResponse.json({ message: "Job not found." }, { status: 404 });
      const failures = [];
      for (const recipient of job.recipients) {
        for (const fileId of [...recipient.temporaryFileIds]) {
          try {
            await deleteDriveFile(fileId);
            recipient.temporaryFileIds = recipient.temporaryFileIds.filter((value) => value !== fileId);
          } catch (error) {
            failures.push(`${fileId}: ${error.message}`);
          }
        }
      }
      await job.save();
      if (failures.length) return NextResponse.json({ message: "Some temporary Drive files could not be deleted.", failures }, { status: 502 });
      return NextResponse.json({ message: "Temporary files cleaned up." });
    } else if (body.action !== "process") {
      return NextResponse.json({ message: "Unsupported job action." }, { status: 400 });
    }

    const job = await runJobBatch(jobId, body.batchNumber ?? null);
    return NextResponse.json({ job: publicJob(job) });
  } catch (error) {
    console.error("Process job error:", error?.name || "unknown error");
    return NextResponse.json(
      { message: getSafeErrorMessage(error) || "Unable to process job." },
      { status: error.status || 500 }
    );
  }
}
