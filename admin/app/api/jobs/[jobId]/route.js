import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import OperationJob from "@/lib/models/OperationJob";
import { requireAdmin } from "@/lib/auth";
import { getJobSummary, retryFailedRecipients, runJobItem } from "@/lib/services/jobService";
import { deleteDriveFile } from "@/lib/services/googleApi";

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
      return NextResponse.json({
        job: {
          _id: job._id,
          type: job.type,
          status: job.status,
          recipientCount: job.recipientCount,
          processedCount: job.processedCount,
          successfulCount: job.successfulCount,
          failedCount: job.failedCount,
        },
      });
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

    const job = await runJobItem(jobId);
    return NextResponse.json({
      job: {
        _id: job._id,
        type: job.type,
        status: job.status,
        recipientCount: job.recipientCount,
        processedCount: job.processedCount,
        successfulCount: job.successfulCount,
        failedCount: job.failedCount,
      },
    });
  } catch (error) {
    console.error("Process job error:", error);
    return NextResponse.json({ message: error.message || "Unable to process job." }, { status: 500 });
  }
}
