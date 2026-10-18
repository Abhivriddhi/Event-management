import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import AttendanceDAY1 from "@/lib/models/AttendanceDAY1";
import AttendanceDAY2 from "@/lib/models/AttendanceDAY2";
import AttendanceCOMBO from "@/lib/models/AttendanceCOMBO";
import { requireAdmin } from "@/lib/auth";
import { authenticateScanner, verifyCrossColorTicket } from "@/lib/services/scannerService";

export async function POST(req) {
  const body = await req.json();
  if (body?.ticketId) {
    await dbConnect();
    try {
      const device = await authenticateScanner(req);
      if (!device) return NextResponse.json({ message: "Scanner authentication required." }, { status: 401 });
      const result = await verifyCrossColorTicket(device, body.ticketId);
      return NextResponse.json(result, { status: result.status });
    } catch (error) {
      console.error("Cross-color attendance verification error:", error);
      return NextResponse.json({ message: "Verification unavailable; refer to the help desk." }, { status: 500 });
    }
  }
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  const { userId, eventName } = body;
  
  try {
    // Parse QR data to extract fields
    const lines = userId.split('\n');
    const parsedData = {};
    
    lines.forEach(line => {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        const value = valueParts.join(':').trim();
        parsedData[key.trim()] = value;
      }
    });
    
    // Normalize parsed data
    const name = parsedData['Name']?.trim().toLowerCase();
    const prn = parsedData['PRN']?.trim() || null;
    const email = parsedData['Email']?.trim().toLowerCase();
    const ticketType = parsedData['TicketType']?.trim();
    
    // Find user by email (primary identifier)
    let user = null;
    
    if (email) {
      user = await User.findOne({ email });
    }
    
    // If not found, try with exact id match
    if (!user) {
      user = await User.findOne({ id: userId });
    }
    
    // If not found, try with normalized newlines
    if (!user) {
      const normalizedUserId = userId.replace(/\\n/g, '\n');
      user = await User.findOne({ id: normalizedUserId });
    }
    
    // If not found, try reverse normalization
    if (!user) {
      const escapedUserId = userId.replace(/\n/g, '\\n');
      user = await User.findOne({ id: escapedUserId });
    }
    
    // If still not found, try partial match (QR might be truncated)
    if (!user) {
      const escapedForRegex = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      user = await User.findOne({ id: { $regex: `^${escapedForRegex}` } });
    }
    
    if (!user) {
      return NextResponse.json(
        { message: "User not found. Please check if the user is registered." },
        { status: 400 }
      );
    }

    const isUserRegisteredForCurrentEvent = user.registeredEvent.includes(eventName);
    if (!isUserRegisteredForCurrentEvent) {
      return NextResponse.json(
        { message: `User not registered for ${eventName}. Registered for: ${user.registeredEvent.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Determine attendance model based on ticketType
    let AttendanceModel;
    if (user.ticketType === "DAY1") {
      AttendanceModel = AttendanceDAY1;
    } else if (user.ticketType === "DAY2") {
      AttendanceModel = AttendanceDAY2;
    } else if (user.ticketType === "COMBO") {
      AttendanceModel = AttendanceCOMBO;
    } else {
      AttendanceModel = AttendanceDAY1; // Default fallback
    }

    // Check if attendance is already marked
    const existingAttendance = await AttendanceModel.findOne({
      userId: user.id,
      registeredEvent: eventName,
    });
    
    if (existingAttendance) {
      return NextResponse.json(
        { message: "Attendance already marked for this user" },
        { status: 400 }
      );
    }

    // Mark attendance
    const attendance = await AttendanceModel.create({ 
      userId: user.id, 
      registeredEvent: eventName,
      timestamp: new Date()
    });

    return NextResponse.json(
      { 
        message: "Attendance marked successfully", 
        user: user.name,
        event: eventName,
        timestamp: attendance.timestamp
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error marking attendance:", error);
    return NextResponse.json(
      { message: "Error marking attendance" },
      { status: 500 }
    );
  }
}
