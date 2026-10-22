"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, QrCode, BarChart2, LogOut, Menu, X, FileJson, Award, Upload, Send, Ticket, Mail, ChevronRight, ChevronLeft, Check, Move } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Scan Attendance", icon: QrCode, href: "/scanner" },
  { label: "Convert to JSON", icon: FileJson, href: "/dashboard/convert-data" },
  { label: "Add Participant", icon: Users, href: "/dashboard/add-participant" },
  { label: "Send Tickets", icon: Ticket, href: "/dashboard/send-tickets" },
  { label: "Send Email", icon: Mail, href: "/send-email" },
  { label: "Total Attendance", icon: BarChart2, href: "/dashboard/attendance" },
  { label: "Send Certificates", icon: Award, href: "/dashboard/certificates" },
];

const TICKET_TYPES = ["ALL", "DAY1", "DAY2", "COMBO"];
const EVENTS = ["ALL", "Event A", "Event B", "Event C"];

const steps = [
  { id: 1, label: "Recipients" },
  { id: 2, label: "Ticket Design" },
  { id: 3, label: "QR Position" },
  { id: 4, label: "Email Content" },
  { id: 5, label: "Review & Send" },
];

// Default QR values from Python script
const DEFAULT_QR_SIZE = 150;
const DEFAULT_QR_X = 432;
const DEFAULT_QR_Y = 65; // (250 - 150) / 2

export default function SendTicketsPage() {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedTicketType, setSelectedTicketType] = useState("ALL");
  const [selectedEvent, setSelectedEvent] = useState("ALL");
  const [ticketFile, setTicketFile] = useState(null);
  const [ticketPreviewUrl, setTicketPreviewUrl] = useState(null);
  const [emailSubject, setEmailSubject] = useState("Your Event Ticket - Abhivriddhi");
  const [emailBody, setEmailBody] = useState(
    "Dear {name},\n\nThank you for registering for {event}!\n\nPlease find your event ticket attached to this email. Kindly present this ticket at the venue for entry.\n\nEvent Details:\n- Event: {event}\n- Ticket Type: {ticketType}\n\nWe look forward to seeing you!\n\nWarm regards,\nAbhivriddhi Team"
  );
  const fileInputRef = useRef(null);

  // QR position state (actual pixel values for Python)
  const [qrSize, setQrSize] = useState(DEFAULT_QR_SIZE);
  const [qrX, setQrX] = useState(DEFAULT_QR_X);
  const [qrY, setQrY] = useState(DEFAULT_QR_Y);

  // For drag/resize on canvas
  const imgRef = useRef(null);
  const [imgNaturalSize, setImgNaturalSize] = useState({ w: 630, h: 280 });
  const [imgDisplaySize, setImgDisplaySize] = useState({ w: 630, h: 280 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [sendBatchState, setSendBatchState] = useState(null);
  const [restoringBatch, setRestoringBatch] = useState(true);
  const batchRequestRef = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, qrX: 0, qrY: 0 });
  const resizeStart = useRef({ mouseX: 0, mouseY: 0, size: 0 });

  useEffect(() => {
    if (localStorage.getItem("isLoggedIn") !== "true") {
      router.push("/login");
    }
  }, [router]);

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem("ticketSendBatchProgress");
      if (savedState) {
        const progress = JSON.parse(savedState);
        if (!progress || !progress.settings || !Number.isInteger(progress.nextBatchIndex)
          || !progress.recipients || typeof progress.recipients !== "object") {
          throw new Error("Saved ticket batch progress is invalid.");
        }
        setSendBatchState(progress);
        setSelectedTicketType(progress.settings.ticketType);
        setSelectedEvent(progress.settings.event);
        setQrX(progress.settings.qrX);
        setQrY(progress.settings.qrY);
        setQrSize(progress.settings.qrSize);
        setEmailSubject(progress.settings.emailSubject);
        setEmailBody(progress.settings.emailBody);
      }
    } catch (error) {
      setSendResult({ type: "error", message: `Unable to restore ticket batch progress: ${error.message}` });
      sessionStorage.removeItem("ticketSendBatchProgress");
    } finally {
      setRestoringBatch(false);
    }
  }, []);

  useEffect(() => {
    if (restoringBatch) return;
    if (!sendBatchState) {
      sessionStorage.removeItem("ticketSendBatchProgress");
      return;
    }
    const settings = { ...sendBatchState.settings };
    delete settings.ticketFile;
    try {
      sessionStorage.setItem("ticketSendBatchProgress", JSON.stringify({ ...sendBatchState, settings }));
    } catch (error) {
      setSendResult({ type: "error", message: `Unable to save ticket batch progress: ${error.message}` });
    }
  }, [sendBatchState, restoringBatch]);

  const handleLogout = () => {
    localStorage.removeItem("isLoggedIn");
    router.push("/login");
  };

  const handleTicketFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setTicketFile(file);
    const url = URL.createObjectURL(file);
    setTicketPreviewUrl(url);
  };

  // When image loads, get its natural + display size
  const handleImgLoad = () => {
    if (!imgRef.current) return;
    setImgNaturalSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
    setImgDisplaySize({ w: imgRef.current.offsetWidth, h: imgRef.current.offsetHeight });
  };

  // Scale factor: display px → actual px
  const scaleX = imgNaturalSize.w / imgDisplaySize.w;
  const scaleY = imgNaturalSize.h / imgDisplaySize.h;

  // QR box in display px
  const dispQrX = qrX / scaleX;
  const dispQrY = qrY / scaleY;
  const dispQrSize = qrSize / scaleX;

  // Drag handlers
  const onMouseDownDrag = (e) => {
    if (sendBatchState) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { mouseX: e.clientX, mouseY: e.clientY, qrX, qrY };
  };

  const onMouseMoveDrag = useCallback((e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragStart.current.mouseX) * scaleX;
    const dy = (e.clientY - dragStart.current.mouseY) * scaleY;
    setQrX(Math.max(0, Math.round(dragStart.current.qrX + dx)));
    setQrY(Math.max(0, Math.round(dragStart.current.qrY + dy)));
  }, [dragging, scaleX, scaleY]);

  const onMouseUpDrag = useCallback(() => {
    setDragging(false);
    setResizing(false);
  }, []);

  // Resize handlers (bottom-right corner)
  const onMouseDownResize = (e) => {
    if (sendBatchState) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    resizeStart.current = { mouseX: e.clientX, mouseY: e.clientY, size: qrSize };
  };

  const onMouseMoveResize = useCallback((e) => {
    if (!resizing) return;
    const dx = (e.clientX - resizeStart.current.mouseX) * scaleX;
    setQrSize(Math.max(50, Math.round(resizeStart.current.size + dx)));
  }, [resizing, scaleX]);

  useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", onMouseMoveDrag);
      window.addEventListener("mouseup", onMouseUpDrag);
    }
    return () => {
      window.removeEventListener("mousemove", onMouseMoveDrag);
      window.removeEventListener("mouseup", onMouseUpDrag);
    };
  }, [dragging, onMouseMoveDrag, onMouseUpDrag]);

  useEffect(() => {
    if (resizing) {
      window.addEventListener("mousemove", onMouseMoveResize);
      window.addEventListener("mouseup", onMouseUpDrag);
    }
    return () => {
      window.removeEventListener("mousemove", onMouseMoveResize);
      window.removeEventListener("mouseup", onMouseUpDrag);
    };
  }, [resizing, onMouseMoveResize, onMouseUpDrag]);

  const canProceed = () => {
    if (currentStep === 2 && !ticketFile) return false;
    return true;
  };

  const sendTicketBatch = async (batchIndex, retryEmails = null) => {
    if (batchRequestRef.current || restoringBatch || sendBatchState?.deliveryUnconfirmed) return;
    const settings = sendBatchState?.settings
      ? { ...sendBatchState.settings, ticketFile: sendBatchState.settings.ticketFile || ticketFile }
      : {
      ticketType: selectedTicketType,
      event: selectedEvent,
      qrX,
      qrY,
      qrSize,
      emailSubject,
      emailBody,
      ticketFile,
    };
    if (!settings.ticketFile) {
      setSendResult({ type: "error", message: "Ticket file is required." });
      return;
    }

    batchRequestRef.current = true;
    setSending(true);
    setSendResult(null);
    let outcomeKnown = false;
    let requestStarted = false;
    try {
      const pendingState = {
        ...(sendBatchState || {}),
        settings,
        totalRecipients: sendBatchState?.totalRecipients || 0,
        nextBatchIndex: sendBatchState?.nextBatchIndex ?? batchIndex,
        hasMore: sendBatchState?.hasMore ?? true,
        nextBatchSize: sendBatchState?.nextBatchSize || 0,
        recipients: sendBatchState?.recipients || {},
        deliveryUnconfirmed: true,
      };
      const pendingSettings = { ...settings };
      delete pendingSettings.ticketFile;
      sessionStorage.setItem("ticketSendBatchProgress", JSON.stringify({
        ...pendingState,
        settings: pendingSettings,
      }));
      setSendBatchState(pendingState);

      const formData = new FormData();
      formData.append("ticketType", settings.ticketType);
      formData.append("event", settings.event);
      formData.append("batchIndex", String(batchIndex));
      formData.append("qrX", String(settings.qrX));
      formData.append("qrY", String(settings.qrY));
      formData.append("qrSize", String(settings.qrSize));
      formData.append("emailSubject", settings.emailSubject);
      formData.append("emailBody", settings.emailBody);
      formData.append("ticketFile", settings.ticketFile);
      if (retryEmails) {
        formData.append("retryEmails", JSON.stringify(retryEmails));
      } else {
        formData.append("attemptedEmails", JSON.stringify(Object.keys(sendBatchState?.recipients || {})));
      }

      const response = await fetch("/api/send-tickets", {
        method: "POST",
        body: formData,
      });
      requestStarted = true;
      const result = await response.json();
      if (!response.ok) {
        outcomeKnown = response.status < 500;
        throw new Error(result.message || "Unable to send this ticket batch.");
      }
      if (!Array.isArray(result.recipients) || !Number.isInteger(result.totalRecipients)) {
        throw new Error("The server returned incomplete batch results.");
      }
      outcomeKnown = true;

      setSendBatchState((current) => {
        const recipients = { ...(current?.recipients || {}) };
        for (const recipient of result.recipients) {
          const key = recipient.email.toLowerCase();
          const previous = recipients[key];
          recipients[key] = {
            ...recipient,
            retryCount: (previous?.retryCount || 0) + (retryEmails ? 1 : 0),
          };
        }
        return {
          settings,
          totalRecipients: result.totalRecipients,
          nextBatchIndex: retryEmails ? current?.nextBatchIndex ?? batchIndex : result.nextBatchIndex,
          hasMore: retryEmails ? current?.hasMore || false : result.hasMore,
          nextBatchSize: retryEmails ? current?.nextBatchSize || 0 : result.nextBatchSize,
          recipients,
          deliveryUnconfirmed: false,
        };
      });
      setSendResult({
        type: result.failed ? "error" : "success",
        message: retryEmails
          ? `Retry complete. Sent: ${result.sent}, Failed: ${result.failed}.`
          : `Batch ${batchIndex + 1} complete. Sent: ${result.sent}, Failed: ${result.failed}.`,
      });
    } catch (error) {
      if (!outcomeKnown) {
        if (requestStarted) {
          setSendBatchState((current) => ({
            ...current,
            settings,
            nextBatchIndex: current?.nextBatchIndex ?? batchIndex,
            deliveryUnconfirmed: true,
          }));
        } else {
          setSendBatchState((current) => current?.totalRecipients
            ? { ...current, deliveryUnconfirmed: false }
            : null);
        }
      } else {
        setSendBatchState((current) => {
          if (!current || (!current.totalRecipients && Object.keys(current.recipients || {}).length === 0)) return null;
          return { ...current, deliveryUnconfirmed: false };
        });
      }
      setSendResult({
        type: "error",
        message: outcomeKnown
          ? error.message
          : requestStarted
            ? `${error.message || "The server response was lost."} Delivery is unconfirmed; this send is paused to prevent duplicate tickets. Verify the email outcome before starting another send.`
            : `Could not save progress before sending, so no ticket was sent. ${error.message || ""}`.trim(),
      });
    } finally {
      batchRequestRef.current = false;
      setSending(false);
    }
  };

  const retryFailedTicketRecipients = () => {
    const failedRecipients = Object.entries(sendBatchState?.recipients || {})
      .filter(([, recipient]) => recipient.status === "failed")
      .sort(([, first], [, second]) => first.retryCount - second.retryCount)
      .slice(0, 10)
      .map(([email]) => email);
    if (failedRecipients.length) {
      sendTicketBatch(sendBatchState.nextBatchIndex, failedRecipients);
    }
  };

  const recipientOutcomes = Object.values(sendBatchState?.recipients || {});
  const sentCount = recipientOutcomes.filter((recipient) => recipient.status === "success").length;
  const failedCount = recipientOutcomes.filter((recipient) => recipient.status === "failed").length;
  const retryCount = Math.min(10, failedCount);
  const progressCount = recipientOutcomes.length;
  const nextBatchCount = sendBatchState
    ? sendBatchState.nextBatchSize
    : 10;
  const totalSteps = steps.length;

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col transition-transform duration-200
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 md:static md:flex`}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <span className="font-bold text-lg tracking-tight">Abhivriddhi</span>
          <button className="md:hidden" onClick={() => setSidebarOpen(false)}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={() => { router.push(item.href); setSidebarOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors",
                item.href === "/dashboard/send-tickets" && "bg-accent"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-border">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium hover:bg-accent transition-colors text-destructive"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        <header className="flex items-center gap-4 px-6 py-4 border-b border-border bg-card">
          <button className="md:hidden" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold text-sm">Send Event Tickets</span>
        </header>

        <main className="flex-1 p-6 overflow-auto">

          {/* Step Indicator */}
          <div className="flex items-center justify-center mb-8 overflow-x-auto pb-2">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={() => step.id < currentStep && setCurrentStep(step.id)}
                    className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors",
                      currentStep === step.id
                        ? "bg-primary text-primary-foreground border-primary"
                        : step.id < currentStep
                        ? "bg-primary/20 text-primary border-primary cursor-pointer"
                        : "bg-background text-muted-foreground border-border"
                    )}
                  >
                    {step.id < currentStep ? <Check className="h-4 w-4" /> : step.id}
                  </button>
                  <span className={cn(
                    "text-xs font-medium whitespace-nowrap",
                    currentStep === step.id ? "text-primary" : "text-muted-foreground"
                  )}>
                    {step.label}
                  </span>
                </div>
                {index < steps.length - 1 && (
                  <div className={cn(
                    "h-0.5 w-12 sm:w-20 mx-2 mb-5 transition-colors",
                    step.id < currentStep ? "bg-primary" : "bg-border"
                  )} />
                )}
              </div>
            ))}
          </div>

          {/* Step Content */}
          <Card className={cn("mx-auto", currentStep === 3 ? "max-w-4xl" : "max-w-2xl")}>

            {/* Step 1 - Recipients */}
            {currentStep === 1 && (
              <>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Select Recipients</CardTitle>
                  <p className="text-sm text-muted-foreground">Choose which participants will receive the event ticket.</p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <label className="text-sm font-medium">Ticket Type</label>
                    <div className="flex gap-2 flex-wrap">
                      {TICKET_TYPES.map((t) => (
                        <button key={t} onClick={() => setSelectedTicketType(t)}
                          disabled={Boolean(sendBatchState)}
                          className={cn("px-4 py-2 rounded-md text-sm font-medium border transition-colors",
                            selectedTicketType === t ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-input hover:bg-accent",
                            sendBatchState && "cursor-not-allowed opacity-60"
                          )}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <label className="text-sm font-medium">Event</label>
                    <div className="flex gap-2 flex-wrap">
                      {EVENTS.map((e) => (
                        <button key={e} onClick={() => setSelectedEvent(e)}
                          disabled={Boolean(sendBatchState)}
                          className={cn("px-4 py-2 rounded-md text-sm font-medium border transition-colors",
                            selectedEvent === e ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-input hover:bg-accent",
                            sendBatchState && "cursor-not-allowed opacity-60"
                          )}>{e}</button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-accent/50 text-sm text-muted-foreground">
                    <Users className="h-4 w-4 shrink-0" />
                    Tickets will be sent to all registered participants matching the selected filters.
                  </div>
                </CardContent>
              </>
            )}

            {/* Step 2 - Upload Ticket Design */}
            {currentStep === 2 && (
              <>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Upload Ticket Design</CardTitle>
                  <p className="text-sm text-muted-foreground">Upload your ticket template image. The QR code will be placed on it in the next step.</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div
                    onClick={() => (!sendBatchState || !ticketFile) && fileInputRef.current?.click()}
                    className={cn(
                      "border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors",
                      ticketFile ? "border-primary bg-accent/30" : "border-border hover:border-primary hover:bg-accent/50",
                      sendBatchState && !ticketFile && "cursor-not-allowed opacity-60"
                    )}
                  >
                    {ticketFile ? (
                      <>
                        <div className="h-12 w-12 rounded-md bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
                          {ticketFile.name.split(".").pop().toUpperCase()}
                        </div>
                        <p className="text-sm font-medium">{ticketFile.name}</p>
                        <p className="text-xs text-muted-foreground">{(ticketFile.size / 1024).toFixed(1)} KB{sendBatchState ? "" : " · Click to change"}</p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-10 w-10 text-muted-foreground" />
                        <div className="text-center">
                          <p className="text-sm font-medium">Click to upload ticket design</p>
                          <p className="text-xs text-muted-foreground mt-1">Supported: PNG, JPG, WEBP</p>
                        </div>
                      </>
                    )}
                  </div>
                  <input ref={fileInputRef} type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden"
                    onChange={handleTicketFileChange} disabled={Boolean(sendBatchState && ticketFile)} />
                  {ticketFile && (
                    <button disabled={Boolean(sendBatchState)} onClick={() => { setTicketFile(null); setTicketPreviewUrl(null); fileInputRef.current.value = ""; }}
                      className="text-xs text-destructive hover:underline">Remove file</button>
                  )}
                </CardContent>
              </>
            )}

            {/* Step 3 - QR Position */}
            {currentStep === 3 && (
              <>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Set QR Code Position</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Drag the <span className="text-green-600 font-medium">green box</span> to position the QR code on your ticket. Drag the <span className="text-green-600 font-medium">bottom-right corner</span> to resize it.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Ticket preview with draggable QR box */}
                  <div className="relative w-full overflow-hidden rounded-lg border border-border select-none">
                    {ticketPreviewUrl ? (
                      <>
                        <img
                          ref={imgRef}
                          src={ticketPreviewUrl}
                          alt="Ticket"
                          className="w-full h-auto block"
                          onLoad={handleImgLoad}
                          draggable={false}
                        />
                        {/* Green QR overlay box */}
                        <div
                          onMouseDown={onMouseDownDrag}
                          style={{
                            position: "absolute",
                            left: `${dispQrX}px`,
                            top: `${dispQrY}px`,
                            width: `${dispQrSize}px`,
                            height: `${dispQrSize}px`,
                            border: "2px solid #16a34a",
                            backgroundColor: "rgba(22,163,74,0.15)",
                            cursor: dragging ? "grabbing" : "grab",
                            boxSizing: "border-box",
                          }}
                        >
                          {/* Move icon center */}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <Move className="h-5 w-5 text-green-600 opacity-80" />
                          </div>
                          {/* QR label */}
                          <div className="absolute top-1 left-1 text-green-700 text-xs font-bold pointer-events-none leading-none">
                            QR
                          </div>
                          {/* Resize handle - bottom right */}
                          <div
                            onMouseDown={onMouseDownResize}
                            style={{
                              position: "absolute",
                              right: -5,
                              bottom: -5,
                              width: 14,
                              height: 14,
                              backgroundColor: "#16a34a",
                              borderRadius: 2,
                              cursor: "se-resize",
                            }}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                        No ticket image uploaded.
                      </div>
                    )}
                  </div>

                  {/* Coordinates display */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-lg border border-border px-4 py-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">QR_X</p>
                      <p className="text-lg font-bold text-green-600">{qrX}</p>
                    </div>
                    <div className="rounded-lg border border-border px-4 py-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">QR_Y</p>
                      <p className="text-lg font-bold text-green-600">{qrY}</p>
                    </div>
                    <div className="rounded-lg border border-border px-4 py-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">QR_SIZE</p>
                      <p className="text-lg font-bold text-green-600">{qrSize}</p>
                    </div>
                  </div>

                  {/* Python code snippet */}
                  <div className="rounded-lg bg-muted/50 border border-border px-4 py-3">
                    <p className="text-xs text-muted-foreground mb-2 font-medium">Python values (auto-updated):</p>
                    <pre className="text-xs font-mono text-foreground leading-relaxed">
{`QR_SIZE = ${qrSize}
QR_X    = ${qrX}
QR_Y    = ${qrY}`}
                    </pre>
                  </div>

                  <Button variant="outline" size="sm" onClick={() => { setQrX(DEFAULT_QR_X); setQrY(DEFAULT_QR_Y); setQrSize(DEFAULT_QR_SIZE); }}>
                    Reset to Default
                  </Button>
                </CardContent>
              </>
            )}

            {/* Step 4 - Email Content */}
            {currentStep === 4 && (
              <>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Email Content</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Customize the email. Use{" "}
                    <code className="bg-accent px-1 rounded text-xs">{"{name}"}</code>,{" "}
                    <code className="bg-accent px-1 rounded text-xs">{"{event}"}</code>,{" "}
                    <code className="bg-accent px-1 rounded text-xs">{"{ticketType}"}</code>{" "}
                    as placeholders.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Subject</label>
                    <input type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} readOnly={Boolean(sendBatchState)}
                      className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Body</label>
                    <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={10} readOnly={Boolean(sendBatchState)}
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y" />
                  </div>
                </CardContent>
              </>
            )}

            {/* Step 5 - Review & Send */}
            {currentStep === 5 && (
              <>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Review & Send</CardTitle>
                  <p className="text-sm text-muted-foreground">Review your settings before sending tickets to participants.</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg border border-border divide-y divide-border text-sm">
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-muted-foreground flex items-center gap-2"><Users className="h-3.5 w-3.5" /> Recipients</span>
                      <span className="font-medium">
                        {selectedTicketType === "ALL" ? "All Ticket Types" : selectedTicketType} · {selectedEvent === "ALL" ? "All Events" : selectedEvent}
                      </span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-muted-foreground flex items-center gap-2"><Ticket className="h-3.5 w-3.5" /> Ticket File</span>
                      <span className={cn("font-medium", !ticketFile && "text-destructive")}>
                        {ticketFile ? ticketFile.name : "Not uploaded"}
                      </span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-muted-foreground flex items-center gap-2"><QrCode className="h-3.5 w-3.5" /> QR Position</span>
                      <span className="font-medium font-mono text-xs">X:{qrX} Y:{qrY} Size:{qrSize}</span>
                    </div>
                    <div className="flex justify-between px-4 py-3">
                      <span className="text-muted-foreground flex items-center gap-2"><Mail className="h-3.5 w-3.5" /> Subject</span>
                      <span className="font-medium truncate max-w-[220px]">{emailSubject}</span>
                    </div>
                  </div>

                  <p className="text-sm text-muted-foreground">Recipients are sent in stable email order, 10 at a time. You can retry confirmed failures without resending successful tickets.</p>

                    {sendResult && (
                    <div className={cn(
                      "px-4 py-3 rounded-lg border text-sm font-medium",
                      sendResult.type === "success"
                        ? "border-green-600 text-green-600 bg-green-50"
                        : "border-destructive text-destructive bg-destructive/10"
                    )}>
                      {sendResult.message}
                    </div>
                  )}

                  {sendBatchState && (
                    <div className="space-y-2 rounded-lg border border-border p-4 text-sm" aria-live="polite">
                      <div className="font-semibold">Ticket batch progress</div>
                      <p>
                        Processed {progressCount} / {sendBatchState.totalRecipients}
                        {" · "}Sent {sentCount}
                        {" · "}Failed {failedCount}
                        {" · "}Next batch {sendBatchState.nextBatchIndex + 1}
                      </p>
                      <progress className="h-2 w-full" value={progressCount} max={sendBatchState.totalRecipients || 1} />
                      {sendBatchState.deliveryUnconfirmed && (
                        <p className="text-amber-700">
                          This batch outcome could not be confirmed. Sending is paused to avoid duplicate tickets; verify delivery before proceeding.
                        </p>
                      )}
                      {recipientOutcomes.length > 0 && (
                        <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-border pt-2">
                          {Object.entries(sendBatchState.recipients).map(([email, recipient]) => (
                            <li key={email} className="flex flex-wrap justify-between gap-x-3">
                              <span>{email}</span>
                              <span className={recipient.status === "success" ? "text-green-700" : "text-destructive"}>
                                {recipient.status === "success" ? "Sent" : `Failed${recipient.reason ? `: ${recipient.reason}` : ""}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!sendBatchState.deliveryUnconfirmed && (sendBatchState.hasMore || !sendBatchState.totalRecipients) && (
                        <Button variant="outline" onClick={() => sendTicketBatch(sendBatchState.nextBatchIndex)} disabled={restoringBatch || sending || !ticketFile}>
                          {sending ? "Sending batch..." : `Send Next Batch (10)${sendBatchState.totalRecipients ? ` · ${nextBatchCount} recipients` : ""}`}
                        </Button>
                      )}
                      {!sendBatchState.deliveryUnconfirmed && failedCount > 0 && (
                        <Button variant="outline" onClick={retryFailedTicketRecipients} disabled={restoringBatch || sending || !ticketFile}>
                          {sending ? "Retrying..." : `Retry Failed Recipients (${retryCount})`}
                        </Button>
                      )}
                    </div>
                  )}

                  {!sendBatchState && (
                    <Button className="w-full" onClick={() => sendTicketBatch(0)} disabled={restoringBatch || sending || !ticketFile}>
                      <Send className="h-4 w-4 mr-2" />
                      {sending ? "Sending batch..." : "Send Next Batch (10)"}
                    </Button>
                  )}
                  {sendBatchState && !sendBatchState.hasMore && failedCount === 0 && !sendBatchState.deliveryUnconfirmed && (
                    <Button className="w-full" variant="outline" onClick={() => {
                      setSendBatchState(null);
                      setSendResult(null);
                    }}>
                      Start a New Ticket Send
                    </Button>
                  )}
                </CardContent>
              </>
            )}

            {/* Navigation */}
            <div className="flex justify-between px-6 pb-6 pt-2">
              <Button variant="outline" onClick={() => setCurrentStep((s) => s - 1)} disabled={currentStep === 1}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              {currentStep < totalSteps && (
                <Button onClick={() => setCurrentStep((s) => s + 1)} disabled={!canProceed()}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>

          </Card>
        </main>
      </div>
    </div>
  );
}
