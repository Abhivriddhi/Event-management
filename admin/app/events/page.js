"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { Award, BarChart3, BookOpen, CalendarDays, FileJson, Mail, QrCode, Ticket, UserCog, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/hooks/useAuth";

const EMPTY_EVENT = {
  eventId: "",
  name: "",
  participantSource: { type: "mongodb", spreadsheetUrl: "", worksheet: "" },
  fieldMappings: { name: "participant.name", email: "participant.email", prn: "participant.prn" },
  ticketTemplates: { red: "", blue: "" },
  certificateTemplateUrl: "",
  ticketSettings: { enabled: true, qrPlaceholder: "{{ticket.qr}}" },
  emailSettings: { enabled: true, delayMs: 1000, dailyLimit: 1500 },
  emailTemplate: {
    subject: "{{event.name}} - Registration confirmation",
    html: "<p>Hello {{participant.name}},</p><p>Your registration for {{event.name}} is confirmed.</p><p>Please find your personalized event document attached when applicable.</p>",
  },
};

const NAV_ITEMS = [
  { label: "Guidelines", href: "/guidelines", icon: BookOpen },
  { label: "Scan Attendance", href: "/scanner", icon: QrCode },
  { label: "Events & Templates", href: "/events", icon: CalendarDays },
  { label: "Convert to JSON", href: "/convert-data", icon: FileJson },
  { label: "Add Participant", href: "/add-participant", icon: UserPlus },
  { label: "Send Tickets", href: "/send-tickets", icon: Ticket },
  { label: "Send Email", href: "/send-email", icon: Mail },
  { label: "Total Attendance", href: "/attendance", icon: BarChart3 },
  { label: "Send Certificates", href: "/certificates", icon: Award },
];

function cleanEvent(event = {}) {
  return {
    ...EMPTY_EVENT,
    ...event,
    ticketTemplates: {
      ...EMPTY_EVENT.ticketTemplates,
      red: event.ticketTemplates?.red || event.ticketTemplateUrl || "",
      blue: event.ticketTemplates?.blue || event.ticketTemplateUrl || "",
    },
    participantSource: { ...EMPTY_EVENT.participantSource, ...(event.participantSource || {}) },
    fieldMappings: event.fieldMappings || {},
    ticketSettings: { ...EMPTY_EVENT.ticketSettings, ...(event.ticketSettings || {}) },
    emailSettings: { ...EMPTY_EVENT.emailSettings, ...(event.emailSettings || {}) },
    emailTemplate: { ...EMPTY_EVENT.emailTemplate, ...(event.emailTemplate || {}) },
  };
}

export default function EventsPage() {
  const router = useRouter();
  const { admin, loading: authLoading, logout } = useAuth();
  const [events, setEvents] = useState([]);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [mappingText, setMappingText] = useState(JSON.stringify(EMPTY_EVENT.fieldMappings, null, 2));
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [emailPreview, setEmailPreview] = useState(null);
  const [operationType, setOperationType] = useState("email");
  const [batchSize, setBatchSize] = useState("5");
  const createJobKeyRef = useRef(null);
  const [attachmentKind, setAttachmentKind] = useState("");
  const [otherAttachment, setOtherAttachment] = useState(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [devices, setDevices] = useState([]);
  const [pairingCode, setPairingCode] = useState("");
  const [tracking, setTracking] = useState({ participants: [], counts: null, pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  const [trackingFilters, setTrackingFilters] = useState({
    search: "",
    ticketStatus: "",
    emailStatus: "",
    color: "",
    scanStatus: "",
  });
  const [trackingPage, setTrackingPage] = useState(1);
  const [trackingLimit, setTrackingLimit] = useState(20);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [selectedParticipant, setSelectedParticipant] = useState(null);
  const navItems = admin?.role === "super_admin"
    ? [...NAV_ITEMS, { label: "Account management", href: "/admin/accounts", icon: UserCog }]
    : NAV_ITEMS;

  const refreshEvents = useCallback(async () => {
    const response = await fetch("/api/events", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unable to load events.");
    setEvents(data.events || []);
  }, []);

  const refreshEventTools = useCallback(async (eventId) => {
    if (!eventId) {
      setJobs([]);
      setDevices([]);
      return;
    }
    const [jobResponse, deviceResponse] = await Promise.all([
      fetch(`/api/events/${encodeURIComponent(eventId)}/jobs`, { cache: "no-store" }),
      fetch(`/api/scanner/devices?eventId=${encodeURIComponent(eventId)}`, { cache: "no-store" }),
    ]);
    const [jobData, deviceData] = await Promise.all([jobResponse.json(), deviceResponse.json()]);
    if (!jobResponse.ok) throw new Error(jobData.message || "Unable to load event jobs.");
    if (!deviceResponse.ok) throw new Error(deviceData.message || "Unable to load scanner devices.");
    setJobs(jobData.jobs || []);
    setDevices(deviceData.devices || []);
    setActiveJob((jobData.jobs || []).find((job) => ["PENDING", "RUNNING", "RETRY_WAIT"].includes(job.status)) || null);
  }, []);

  const refreshTracking = useCallback(async (eventId = selectedEventId) => {
    if (!eventId) {
      setTracking({ participants: [], counts: null, pagination: { page: 1, limit: trackingLimit, total: 0, pages: 1 } });
      return;
    }
    const query = new URLSearchParams({
      page: String(trackingPage),
      limit: String(trackingLimit),
      ...trackingFilters,
    });
    setTrackingLoading(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/participants?${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to load participant tracking.");
      setTracking(data);
    } finally {
      setTrackingLoading(false);
    }
  }, [selectedEventId, trackingFilters, trackingLimit, trackingPage]);

  useEffect(() => {
    if (!authLoading && selectedEventId) {
      refreshTracking().catch((error) => setNotice(error.message));
    } else if (!selectedEventId) {
      setTracking({ participants: [], counts: null, pagination: { page: 1, limit: trackingLimit, total: 0, pages: 1 } });
    }
  }, [authLoading, refreshTracking, selectedEventId, trackingLimit]);

  useEffect(() => {
    if (authLoading) return;
    refreshEvents().catch((error) => setNotice(error.message));
  }, [authLoading, refreshEvents]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("operation");
    if (["email", "ticket", "certificate"].includes(requested)) setOperationType(requested);
  }, []);

  const changeForm = (key, value) => setEventForm((current) => ({ ...current, [key]: value }));
  const changeNested = (group, key, value) => setEventForm((current) => ({
    ...current,
    [group]: { ...current[group], [key]: value },
  }));

  const chooseEvent = async (eventId) => {
    setNotice("");
    setSelectedEventId(eventId);
    setTrackingPage(1);
    setTrackingFilters({ search: "", ticketStatus: "", emailStatus: "", color: "", scanStatus: "" });
    setSelectedParticipant(null);
    setSourcePreview(null);
    setEmailPreview(null);
    if (!eventId) {
      setEventForm(EMPTY_EVENT);
      setMappingText(JSON.stringify(EMPTY_EVENT.fieldMappings, null, 2));
      await refreshEventTools("");
      return;
    }
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to load event.");
      const next = cleanEvent(data.event);
      setEventForm(next);
      setMappingText(JSON.stringify(next.fieldMappings, null, 2));
      await refreshEventTools(eventId);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const persistEvent = async () => {
    let fieldMappings;
    try {
      fieldMappings = JSON.parse(mappingText || "{}");
    } catch {
      throw new Error("Field mappings must be valid JSON.");
    }
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...eventForm, fieldMappings }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unable to save event.");
    return data.event;
  };

  const saveEvent = async () => {
    setBusy(true);
    setNotice("");
    try {
      const event = await persistEvent();
      setEventForm(cleanEvent(event));
      setMappingText(JSON.stringify(event.fieldMappings || {}, null, 2));
      setSelectedEventId(event.eventId);
      await refreshEvents();
      await refreshEventTools(event.eventId);
      setNotice("Event configuration saved.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const previewSource = async () => {
    if (!eventForm.eventId) return setNotice("Save the event before previewing its source.");
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventForm.eventId)}/preview-source`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Source preview failed.");
      setSourcePreview(data);
      setNotice("");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importExcel = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !eventForm.eventId) return;
    setBusy(true);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
      const response = await fetch(`/api/events/${encodeURIComponent(eventForm.eventId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-excel", rows }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Excel import failed.");
      changeNested("participantSource", "type", "excel");
      await refreshEvents();
      await previewSource();
      setNotice(`Imported ${data.imported} rows into this event's Excel source.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };

  const previewEmail = async () => {
    if (!eventForm.eventId) return setNotice("Save the event and map a participant source first.");
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventForm.eventId)}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview-email", subject: eventForm.emailTemplate.subject, html: eventForm.emailTemplate.html }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Email preview failed.");
      setEmailPreview(data.preview);
      setNotice("");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTestEmail = async () => {
    if (!eventForm.eventId) return setNotice("Save the event before sending a test email.");
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventForm.eventId)}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test-email",
          to: testRecipient,
          subject: eventForm.emailTemplate.subject,
          html: eventForm.emailTemplate.html,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Test email failed.");
      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const createJob = async () => {
    if (!selectedEventId) return setNotice("Save and select an event before queueing an operation.");
    createJobKeyRef.current ||= localStorage.getItem("eventJobRequestKey") || crypto.randomUUID();
    localStorage.setItem("eventJobRequestKey", createJobKeyRef.current);
    setBusy(true);
    try {
      const savedEvent = await persistEvent();
      setEventForm(cleanEvent(savedEvent));
      setMappingText(JSON.stringify(savedEvent.fieldMappings || {}, null, 2));
      setSelectedEventId(savedEvent.eventId);
      await refreshEvents();

      let attachment;
      if (otherAttachment) {
        if (otherAttachment.size > 6 * 1024 * 1024) throw new Error("Choose an attachment smaller than 6 MB.");
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(otherAttachment);
        });
        attachment = { filename: otherAttachment.name, mimeType: otherAttachment.type, base64: dataUrl };
      }
      const response = await fetch(`/api/events/${encodeURIComponent(savedEvent.eventId)}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: operationType,
          attachmentKind: operationType === "email" ? attachmentKind : "",
          attachment,
          subject: eventForm.emailTemplate.subject,
          html: eventForm.emailTemplate.html,
          batchSize: Number(batchSize),
          idempotencyKey: createJobKeyRef.current,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not queue operation.");
      createJobKeyRef.current = null;
      localStorage.removeItem("eventJobRequestKey");
      setActiveJob(data.job);
      setNotice(`${data.job.type} operation queued for ${data.job.recipientCount} recipients.`);
      await refreshEventTools(savedEvent.eventId);
      setActiveJob(data.job);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const activeJobId = activeJob?._id;
  const activeJobStatus = activeJob?.status;

  useEffect(() => {
    if (!activeJobId || !["PENDING", "RUNNING", "RETRY_WAIT"].includes(activeJobStatus)) return;
    let stopped = false;
    let timer;
    const refreshProgress = async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Job progress could not be loaded.");
        if (stopped) return;
        setActiveJob(data.job);
        setJobs((current) => current.map((job) => job._id === data.job._id ? { ...job, ...data.job } : job));
        if (["PENDING", "RUNNING", "RETRY_WAIT"].includes(data.job.status)) {
          timer = setTimeout(refreshProgress, 3000);
        } else {
          await refreshEventTools(selectedEventId);
        }
      } catch (error) {
        if (stopped) return;
        setNotice(`Job progress unavailable: ${error.message}. Scheduled processing continues independently.`);
        timer = setTimeout(refreshProgress, 5000);
      }
    };
    timer = setTimeout(refreshProgress, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [activeJobId, activeJobStatus, refreshEventTools, selectedEventId]);

  const createScannerDevice = async (color) => {
    if (!selectedEventId) return;
    try {
      const response = await fetch("/api/scanner/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: selectedEventId, color }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to provision scanner.");
      setPairingCode(data.pairingCode);
      setNotice(`${color.toUpperCase()} scanner code is single-use and expires in ${data.expiresInMinutes} minutes.`);
      await refreshEventTools(selectedEventId);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const disableDevice = async (deviceId) => {
    const response = await fetch("/api/scanner/devices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, active: false }),
    });
    const data = await response.json();
    if (!response.ok) return setNotice(data.message || "Unable to revoke scanner.");
    await refreshEventTools(selectedEventId);
  };

  const retryJob = async (jobId) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    });
    const data = await response.json();
    if (!response.ok) return setNotice(data.message || "Retry failed.");
    setActiveJob(data.job);
    await refreshEventTools(selectedEventId);
    setActiveJob(data.job);
  };

  const cleanupJob = async (jobId) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup" }),
    });
    const data = await response.json();
    if (!response.ok) return setNotice(data.message || "Temporary file cleanup failed.");
    setNotice(data.message);
    await refreshEventTools(selectedEventId);
  };

  const changeTrackingFilter = (key, value) => {
    setTrackingFilters((current) => ({ ...current, [key]: value }));
    setTrackingPage(1);
  };

  const exportParticipants = async () => {
    if (!selectedEventId) return;
    const query = new URLSearchParams({ format: "csv", ...trackingFilters });
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}/participants?${query}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "CSV export failed.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedEventId}-participants.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Participant CSV exported.");
    } catch (error) {
      setNotice(error.message);
    }
  };

  const resendTicket = async (participant) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend", participantKey: participant.key }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to queue ticket resend.");
      setActiveJob(data.job);
      setNotice(data.message);
      await refreshEventTools(selectedEventId);
      setActiveJob(data.job);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteParticipant = async (participant) => {
    if (!window.confirm(`Delete ${participant.name || participant.email} from this event? Their event ticket and event-job record will also be removed.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}/participants`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantKey: participant.key }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to delete participant.");
      setSelectedParticipant(null);
      setNotice(data.message);
      await refreshTracking();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async () => {
    if (!selectedEventId) return;
    const confirmation = window.prompt(`Permanently delete ${selectedEventId} and its event-specific records? Type the event ID to confirm.`);
    if (confirmation !== selectedEventId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEventId: confirmation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to delete event.");
      setSelectedEventId("");
      setEventForm(EMPTY_EVENT);
      setSelectedParticipant(null);
      await refreshEvents();
      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (authLoading) return null;

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="border-b border-border px-6 py-5 font-bold text-lg">Abhivriddhi</div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map(({ label, href, icon: Icon }) => (
            <button key={href} onClick={() => router.push(href)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${href === "/events" ? "bg-accent font-semibold" : ""}`}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <button onClick={logout} className="border-t border-border p-4 text-left text-sm text-destructive">Log out</button>
      </aside>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 p-4 md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Events, Templates & Operations</h1>
            <p className="mt-1 text-sm text-muted-foreground">Configure participant sources and field mappings, then queue personalized ticket, certificate, or email jobs.</p>
          </div>
          <div className="flex gap-2">
            <select value={selectedEventId} onChange={(e) => chooseEvent(e.target.value)}
              className="h-10 min-w-52 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">New event…</option>
              {events.map((event) => <option key={event.eventId} value={event.eventId}>{event.name} ({event.eventId})</option>)}
            </select>
            <Button variant="outline" onClick={() => chooseEvent("")}>New</Button>
          </div>
        </header>
        <nav className="flex gap-2 overflow-x-auto pb-1 md:hidden">
          {navItems.map(({ label, href, icon: Icon }) => (
            <button key={href} onClick={() => router.push(href)}
              className={`flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-xs ${href === "/events" ? "bg-accent font-semibold" : "bg-card"}`}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        {notice && <div role="status" className="rounded-md border border-border bg-card p-3 text-sm">{notice}</div>}

        <Card>
          <CardHeader><CardTitle>1 · Event and participant source</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">Event ID
              <input value={eventForm.eventId} onChange={(e) => changeForm("eventId", e.target.value)}
                placeholder="spring-workshop" className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="space-y-1 text-sm">Event name
              <input value={eventForm.name} onChange={(e) => changeForm("name", e.target.value)}
                placeholder="Spring Workshop" className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="space-y-1 text-sm">Participant source
              <select value={eventForm.participantSource.type}
                onChange={(e) => changeNested("participantSource", "type", e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3">
                <option value="mongodb">Existing MongoDB participants</option>
                <option value="excel">Imported Excel workbook</option>
                <option value="googleSheets">Google Sheets (server-side)</option>
              </select>
            </label>
            {eventForm.participantSource.type === "googleSheets" && (
              <>
                <label className="space-y-1 text-sm md:col-span-2">Google Sheets URL
                  <input value={eventForm.participantSource.spreadsheetUrl}
                    onChange={(e) => changeNested("participantSource", "spreadsheetUrl", e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…" className="h-10 w-full rounded-md border border-input bg-background px-3" />
                  <span className="block text-xs text-muted-foreground">Share the sheet with the configured server-side Google service account. Credentials never go to the browser.</span>
                </label>
                <label className="space-y-1 text-sm">Worksheet title or gid
                  <input value={eventForm.participantSource.worksheet}
                    onChange={(e) => changeNested("participantSource", "worksheet", e.target.value)}
                    placeholder="Participants or 0" className="h-10 w-full rounded-md border border-input bg-background px-3" />
                </label>
              </>
            )}
            <label className="space-y-1 text-sm md:col-span-2">Field mappings · source column → participant property
              <textarea rows={6} value={mappingText} onChange={(e) => setMappingText(e.target.value)}
                className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs" />
              <span className="block text-xs text-muted-foreground">Example: {`{"Full Name":"participant.name","Email ID":"participant.email","Department":"participant.department"}`}. Unmapped columns are retained as normalized custom participant fields.</span>
            </label>
            {eventForm.participantSource.type === "excel" && (
              <label className="space-y-1 text-sm md:col-span-2">Import Excel participants
                <input type="file" accept=".xlsx,.xls,.csv" disabled={!eventForm.eventId || busy}
                  onChange={importExcel} className="block w-full rounded-md border border-input p-2" />
                <span className="block text-xs text-muted-foreground">Rows are stored against this event; field mapping is applied when the operation runs.</span>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <Button onClick={saveEvent} disabled={busy}>{busy ? "Saving…" : "Save event configuration"}</Button>
              <Button variant="outline" onClick={previewSource} disabled={busy || !selectedEventId}>Preview source fields</Button>
              {selectedEventId && <Button variant="destructive" onClick={deleteEvent} disabled={busy}>Permanently delete event</Button>}
              {sourcePreview && <span className="text-sm text-muted-foreground">{sourcePreview.rowCount} participants · {sourcePreview.fields.join(", ")}</span>}
            </div>
          </CardContent>
        </Card>

        {selectedEventId && (
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Participant &amp; Ticket Tracking</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">Event-specific participant, ticket, delivery, and scan status.</p>
              </div>
              <Button variant="outline" onClick={exportParticipants} disabled={trackingLoading}>Export CSV</Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ["Total Participants", tracking.counts?.totalParticipants],
                  ["Tickets Generated", tracking.counts?.ticketsGenerated],
                  ["Tickets Sent", tracking.counts?.ticketsSent],
                  ["Red Tickets", tracking.counts?.redTickets],
                  ["Blue Tickets", tracking.counts?.blueTickets],
                  ["Scanned", tracking.counts?.scanned],
                  ["Not Scanned", tracking.counts?.notScanned],
                  ["Failed", tracking.counts?.failed],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-md border border-border p-3">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="mt-1 text-xl font-semibold">{count ?? "—"}</div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <input value={trackingFilters.search} onChange={(e) => changeTrackingFilter("search", e.target.value)}
                  placeholder="Search name, PRN, email, ticket ID" aria-label="Search participants"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm lg:col-span-2" />
                <select value={trackingFilters.ticketStatus} onChange={(e) => changeTrackingFilter("ticketStatus", e.target.value)}
                  aria-label="Filter by ticket status" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">All ticket statuses</option><option value="GENERATED">Generated</option><option value="NOT GENERATED">Not generated</option>
                </select>
                <select value={trackingFilters.emailStatus} onChange={(e) => changeTrackingFilter("emailStatus", e.target.value)}
                  aria-label="Filter by email status" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">All email statuses</option><option value="SENT">Sent</option><option value="FAILED">Failed</option><option value="PENDING">Pending</option><option value="PROCESSING">Processing</option><option value="NOT SENT">Not sent</option>
                </select>
                <select value={trackingFilters.color} onChange={(e) => changeTrackingFilter("color", e.target.value)}
                  aria-label="Filter by ticket color" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">All colors</option><option value="red">Red</option><option value="blue">Blue</option>
                </select>
                <select value={trackingFilters.scanStatus} onChange={(e) => changeTrackingFilter("scanStatus", e.target.value)}
                  aria-label="Filter by scan status" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">All scan statuses</option><option value="SCANNED">Scanned</option><option value="NOT SCANNED">Not scanned</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  Rows
                  <select value={trackingLimit} onChange={(e) => { setTrackingLimit(Number(e.target.value)); setTrackingPage(1); }}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground">
                    <option value={20}>20</option><option value={50}>50</option><option value={100}>100</option>
                  </select>
                  per page
                </label>
              </div>

              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[1150px] border-collapse text-left text-sm">
                  <thead className="bg-muted/60">
                    <tr>{["Name", "PRN", "Email", "Ticket ID", "Color", "Ticket Status", "Email Status", "Scanned", "Scanned At", "Actions"].map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tracking.participants.map((participant) => (
                      <tr key={participant.key} className="border-t border-border">
                        <td className="px-3 py-2">{participant.name || "—"}</td>
                        <td className="px-3 py-2">{participant.prn || "—"}</td>
                        <td className="px-3 py-2">{participant.email || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{participant.ticketId || "—"}</td>
                        <td className="px-3 py-2">{participant.color ? participant.color.toUpperCase() : "—"}</td>
                        <td className="px-3 py-2">{participant.ticketStatus}</td>
                        <td className="px-3 py-2">{participant.emailStatus}</td>
                        <td className="px-3 py-2">{participant.scanned ? "SCANNED" : "NOT SCANNED"}</td>
                        <td className="px-3 py-2">{participant.scannedAt ? new Date(participant.scannedAt).toLocaleString() : "—"}</td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => setSelectedParticipant(participant)}>View</Button>
                            {participant.ticketStatus === "GENERATED" && <Button size="sm" variant="outline" disabled={busy} onClick={() => resendTicket(participant)}>Resend</Button>}
                            <Button size="sm" variant="destructive" disabled={busy} onClick={() => deleteParticipant(participant)}>Delete</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!tracking.participants.length && (
                      <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">{trackingLoading ? "Loading participants…" : "No participants match this event and filter."}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {tracking.pagination.total ? `${(tracking.pagination.page - 1) * tracking.pagination.limit + 1}–${Math.min(tracking.pagination.page * tracking.pagination.limit, tracking.pagination.total)} of ${tracking.pagination.total}` : "0 participants"}
                  {trackingLoading ? " · Updating…" : ""}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={trackingPage <= 1 || trackingLoading} onClick={() => setTrackingPage((page) => page - 1)}>Previous</Button>
                  <span className="px-2 py-2">Page {tracking.pagination.page} of {tracking.pagination.pages}</span>
                  <Button variant="outline" size="sm" disabled={trackingPage >= tracking.pagination.pages || trackingLoading} onClick={() => setTrackingPage((page) => page + 1)}>Next</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {selectedParticipant && (
          <div role="dialog" aria-modal="true" aria-label="Participant details" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="max-h-[90vh] w-full max-w-2xl overflow-y-auto">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle>Participant &amp; Ticket Details</CardTitle>
                <Button variant="outline" size="sm" onClick={() => setSelectedParticipant(null)}>Close</Button>
              </CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                <section className="space-y-2 text-sm">
                  <h3 className="font-semibold">Participant</h3>
                  <p>Name: {selectedParticipant.name || "—"}</p><p>PRN: {selectedParticipant.prn || "—"}</p><p>Email: {selectedParticipant.email || "—"}</p>
                </section>
                <section className="space-y-2 text-sm">
                  <h3 className="font-semibold">Ticket</h3>
                  <p>Ticket ID: {selectedParticipant.ticketId || "—"}</p><p>Color: {selectedParticipant.color || "—"}</p>
                  <p>Generated status: {selectedParticipant.ticketStatus}</p>
                  <p>Template: {selectedParticipant.templateUrl ? <a className="break-all text-primary underline" href={selectedParticipant.templateUrl} target="_blank" rel="noreferrer">{selectedParticipant.templateUrl}</a> : "—"}</p>
                </section>
                <section className="space-y-2 text-sm">
                  <h3 className="font-semibold">Email</h3>
                  <p>Status: {selectedParticipant.emailStatus}</p><p>Sent time: {selectedParticipant.sentAt ? new Date(selectedParticipant.sentAt).toLocaleString() : "—"}</p>
                  {selectedParticipant.failureReason && <p className="break-words text-destructive">Failure reason: {selectedParticipant.failureReason}</p>}
                </section>
                <section className="space-y-2 text-sm">
                  <h3 className="font-semibold">Scanner</h3>
                  <p>Status: {selectedParticipant.scanned ? "SCANNED" : "NOT SCANNED"}</p>
                  <p>Scan time: {selectedParticipant.scannedAt ? new Date(selectedParticipant.scannedAt).toLocaleString() : "—"}</p>
                  <p>Device: {selectedParticipant.scanner ? `${selectedParticipant.scanner.name} (${selectedParticipant.scanner.color})` : "—"}</p>
                </section>
              </CardContent>
            </Card>
          </div>
        )}

        <Card>
          <CardHeader><CardTitle>2 · Shared Google Slides templates</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">Red Ticket Google Slides URL
              <input value={eventForm.ticketTemplates.red}
                onChange={(e) => setEventForm((current) => ({
                  ...current,
                  ticketTemplates: { ...current.ticketTemplates, red: e.target.value },
                }))}
                placeholder="https://docs.google.com/presentation/d/…" className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="space-y-1 text-sm">Blue Ticket Google Slides URL
              <input value={eventForm.ticketTemplates.blue}
                onChange={(e) => setEventForm((current) => ({
                  ...current,
                  ticketTemplates: { ...current.ticketTemplates, blue: e.target.value },
                }))}
                placeholder="https://docs.google.com/presentation/d/…" className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <p className="text-xs text-muted-foreground md:col-span-2">Both ticket templates use mapped {"{{participant.*}}"}, {"{{event.name}}"}, {"{{ticket.id}}"}, and one {"{{ticket.qr}}"} placeholder. The source templates are copied, not modified.</p>
            <label className="space-y-1 text-sm">Certificate Google Slides URL
              <input value={eventForm.certificateTemplateUrl} onChange={(e) => changeForm("certificateTemplateUrl", e.target.value)}
                placeholder="https://docs.google.com/presentation/d/…" className="h-10 w-full rounded-md border border-input bg-background px-3" />
              <span className="block text-xs text-muted-foreground">Certificates accept participant/event placeholders only—no ticket ID or QR.</span>
            </label>
            <label className="space-y-1 text-sm">QR placeholder
              <input value={eventForm.ticketSettings.qrPlaceholder}
                onChange={(e) => changeNested("ticketSettings", "qrPlaceholder", e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <div className="flex flex-col justify-center gap-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={eventForm.ticketSettings.enabled}
                onChange={(e) => changeNested("ticketSettings", "enabled", e.target.checked)} /> Tickets enabled</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={eventForm.emailSettings.enabled}
                onChange={(e) => changeNested("emailSettings", "enabled", e.target.checked)} /> Email sending enabled</label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>3 · Custom HTML email and delivery settings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-1 text-sm">Subject
              <input value={eventForm.emailTemplate.subject}
                onChange={(e) => changeNested("emailTemplate", "subject", e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="block space-y-1 text-sm">HTML body
              <textarea rows={9} value={eventForm.emailTemplate.html}
                onChange={(e) => changeNested("emailTemplate", "html", e.target.value)}
                className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs" />
              <span className="block text-xs text-muted-foreground">Variables include mapped participant properties, {`{{event.name}}`}, and (for ticket jobs) {`{{ticket.id}}`}. Participant values are HTML-escaped.</span>
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">Email spacing (ms)
                <input type="number" min="0" value={eventForm.emailSettings.delayMs}
                  onChange={(e) => changeNested("emailSettings", "delayMs", Number(e.target.value))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3" />
              </label>
              <label className="space-y-1 text-sm">Daily email ceiling
                <input type="number" min="1" value={eventForm.emailSettings.dailyLimit}
                  onChange={(e) => changeNested("emailSettings", "dailyLimit", Number(e.target.value))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3" />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={previewEmail} disabled={busy}>Preview with a participant</Button>
              <input type="email" value={testRecipient} onChange={(e) => setTestRecipient(e.target.value)}
                placeholder="test recipient email" className="h-10 min-w-56 rounded-md border border-input bg-background px-3 text-sm" />
              <Button variant="outline" onClick={sendTestEmail} disabled={busy || !testRecipient}>Send test email</Button>
            </div>
            {emailPreview && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium">Subject: {emailPreview.subject}</p>
                <iframe title="Rendered email preview" sandbox="" srcDoc={emailPreview.html}
                  className="h-72 w-full rounded border border-border bg-white" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>4 · Persistent batch operation</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">Operation
              <select value={operationType} onChange={(e) => setOperationType(e.target.value)}
                className="h-10 rounded-md border border-input bg-background px-3">
                <option value="email">Custom email</option>
                <option value="ticket">Personalized ticket PDF + email</option>
                <option value="certificate">Personalized certificate PDF + email</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">Recipients per batch
              <select value={batchSize} onChange={(e) => setBatchSize(e.target.value)}
                className="h-10 rounded-md border border-input bg-background px-3">
                {Array.from({ length: 10 }, (_, index) => index + 1).map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            {operationType === "email" && (
              <>
                <label className="space-y-1 text-sm">PDF attachment
                  <select value={attachmentKind} onChange={(e) => setAttachmentKind(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3">
                    <option value="">No generated PDF</option>
                    <option value="ticket">Generate and attach ticket PDF</option>
                    <option value="certificate">Generate and attach certificate PDF</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">Optional file
                  <input type="file" onChange={(e) => setOtherAttachment(e.target.files?.[0] || null)}
                    className="block h-10 max-w-60 rounded-md border border-input p-2 text-xs" />
                </label>
              </>
            )}
            <Button disabled={busy || !selectedEventId} onClick={createJob}>Queue operation</Button>
            <p className="basis-full text-xs text-muted-foreground">Scheduled processing sends recipients in batches of up to {batchSize}. Progress is stored in the database and continues when this page is closed.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>5 · Offline scanner devices</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!selectedEventId} onClick={() => router.push("/scanner")}>Open Scanner</Button>
              <Button variant="outline" disabled={!selectedEventId} onClick={() => createScannerDevice("red")}>Provision RED scanner</Button>
              <Button variant="outline" disabled={!selectedEventId} onClick={() => createScannerDevice("blue")}>Provision BLUE scanner</Button>
              {pairingCode && <code className="rounded bg-muted p-3 text-sm">{pairingCode}</code>}
            </div>
            <p className="text-xs text-muted-foreground">Pairing codes are single-use and expire after 30 minutes. Scanner tokens are per-device and revocable; same-color scans stay local, with manual used-ticket sync.</p>
            <div className="space-y-2">
              {devices.map((device) => (
                <div key={device._id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
                  <span>{device.name} · {device.color.toUpperCase()} · {device.active ? "Active" : "Revoked"} · {device.pairedAt ? "Paired" : "Not paired"}</span>
                  {device.active && <Button size="sm" variant="destructive" onClick={() => disableDevice(device._id)}>Revoke</Button>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Persistent operations</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {activeJob && ["PENDING", "RUNNING", "RETRY_WAIT"].includes(activeJob.status) && (
              <div className="rounded-md border border-primary p-3 text-sm">
                <div className="font-semibold">{activeJob.type} · {activeJob.status}</div>
                <div className="mt-1">Batch: {activeJob.currentBatch || 1} · Processed: {activeJob.processedCount || 0} / {activeJob.recipientCount} · Pending: {activeJob.pendingCount || 0} · Processing: {activeJob.processingCount || 0} · Successful: {activeJob.successfulCount || 0} · Failed: {activeJob.failedCount || 0} · Unknown: {activeJob.unknownCount || 0}</div>
                <progress className="mt-2 h-2 w-full" value={activeJob.processedCount || 0} max={activeJob.recipientCount || 1} />
              </div>
            )}
            {jobs.map((job) => (
              <div key={job._id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                <div>
                  <div className="font-medium capitalize">{job.type} · {job.status}</div>
                  <div className="text-muted-foreground">Batch {job.currentBatch || 1} · Processed {job.processedCount} / {job.recipientCount} · Success {job.successfulCount} · Failed {job.failedCount} · Unknown {job.unknownCount || 0}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {["PARTIAL", "FAILED"].includes(job.status) && job.recipients?.some((recipient) => recipient.status === "FAILED" && recipient.retryable) && <Button size="sm" variant="outline" onClick={() => retryJob(job._id)}>Retry eligible failures</Button>}
                  {job.pendingCleanupCount > 0 && <Button size="sm" variant="outline" onClick={() => cleanupJob(job._id)}>Clean {job.pendingCleanupCount} temp files</Button>}
                </div>
                {job.recipients?.some((recipient) => recipient.status === "FAILED") && (
                  <ul className="basis-full space-y-1 text-xs text-destructive">
                    {job.recipients.filter((recipient) => recipient.status === "FAILED").slice(0, 10).map((recipient) => (
                      <li key={`${job._id}-${recipient.email}`}>{recipient.email}: {recipient.lastError}</li>
                    ))}
                  </ul>
                )}
                {job.recipients?.some((recipient) => recipient.status === "UNKNOWN") && (
                  <p className="basis-full text-xs text-amber-700">
                    Delivery outcome unknown for some recipients; verify with the email provider before resending.
                  </p>
                )}
              </div>
            ))}
            {!jobs.length && <p className="text-sm text-muted-foreground">No operations have been queued for this event.</p>}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
