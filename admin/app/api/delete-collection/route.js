import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import AttendanceDAY1 from "@/lib/models/AttendanceDAY1";
import AttendanceDAY2 from "@/lib/models/AttendanceDAY2";
import AttendanceCOMBO from "@/lib/models/AttendanceCOMBO";
import CertificateSent from "@/lib/models/CertificateSent";
import { requireAdmin } from "@/lib/auth";

const modelMap = {
  users: User,
  attendanceday1s: AttendanceDAY1,
  attendanceday2s: AttendanceDAY2,
  attendancecombos: AttendanceCOMBO,
  certificatesents: CertificateSent,
};

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  const { collection } = await req.json();

  if (!collection) {
    return NextResponse.json({ message: "Invalid collection name" }, { status: 400 });
  }

  try {
    // Delete everything from all collections
    if (collection === "all") {
      const results = await Promise.all(
        Object.values(modelMap).map((model) => model.deleteMany({}))
      );
      const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0);
      return NextResponse.json({
        message: `Deleted everything — ${totalDeleted} total documents removed from all collections.`,
      });
    }

    if (!modelMap[collection]) {
      return NextResponse.json({ message: "Invalid collection name" }, { status: 400 });
    }

    const result = await modelMap[collection].deleteMany({});
    return NextResponse.json({
      message: `Deleted ${result.deletedCount} documents from ${collection}`,
    });
  } catch (error) {
    console.error("Error deleting collection:", error);
    return NextResponse.json({ message: "Error deleting collection" }, { status: 500 });
  }
}
