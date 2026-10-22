"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QrScanner from "@/components/QrScanner";
import { scannerStore } from "@/lib/scannerStore";

const TICKET_ID = /^[A-F0-9]{12}[01]$/i;

export default function ScannerPanel() {
  const [device, setDevice] = useState(null);
  const [pairingCode, setPairingCode] = useState("");
  const [status, setStatus] = useState({ kind: "idle", title: "Ready to scan", detail: "Point the camera at a ticket QR code." });
  const [ready, setReady] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);
  const [loading, setLoading] = useState(true);
  const scanLock = useRef(false);
  const deviceRef = useRef(null);

  const refreshPendingCount = useCallback(async () => {
    const used = await scannerStore.getAll("used");
    setPendingSync(used.filter((ticket) => !ticket.synced).length);
  }, []);

  const clearRevokedDevice = useCallback(async () => {
    await Promise.all([scannerStore.clear("valid"), scannerStore.clear("meta")]);
    deviceRef.current = null;
    setDevice(null);
    setReady(false);
    await refreshPendingCount();
  }, [refreshPendingCount]);

  const downloadHashset = useCallback(async (currentDevice, clearUsed = false) => {
    const response = await fetch("/api/scanner/hashset", {
      headers: { Authorization: `Bearer ${currentDevice.token}` },
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.message || "Could not download this counter's ticket list.");
      error.status = response.status;
      throw error;
    }
    if (
      result.eventId !== currentDevice.eventId
      || result.color !== currentDevice.color
      || !Array.isArray(result.ids)
    ) {
      throw new Error("The downloaded ticket list does not match this scanner device.");
    }

    const previous = await scannerStore.get("meta", "eventId");
    if (previous?.value !== currentDevice.eventId || clearUsed) await scannerStore.clear("used");
    await scannerStore.clear("valid");
    for (const id of result.ids) await scannerStore.put("valid", { id });
    await scannerStore.put("meta", { key: "device", value: currentDevice });
    await scannerStore.put("meta", { key: "eventId", value: currentDevice.eventId });
    setDevice(currentDevice);
    deviceRef.current = currentDevice;
    setReady(true);
    await refreshPendingCount();
    setStatus({ kind: "idle", title: "Scanner ready", detail: `${result.ids.length} ${currentDevice.color.toUpperCase()} tickets are available offline.` });
  }, [refreshPendingCount]);

  useEffect(() => {
    let mounted = true;
    const restore = async () => {
      try {
        const saved = await scannerStore.get("meta", "device");
        if (saved?.value) {
          if (navigator.onLine) {
            try {
              await downloadHashset(saved.value);
            } catch (error) {
              if (error.status === 401) {
                await clearRevokedDevice();
                if (mounted) {
                  setStatus({
                    kind: "deny",
                    title: "SCANNER REVOKED",
                    detail: "This device is no longer authorized. Ask an administrator for a new pairing code.",
                  });
                }
              } else {
                const valid = await scannerStore.getAll("valid");
                setDevice(saved.value);
                deviceRef.current = saved.value;
                setReady(true);
                setStatus({
                  kind: "warn",
                  title: valid.length ? "OFFLINE SCANNER READY" : "TICKET LIST UNAVAILABLE",
                  detail: valid.length
                    ? `Using ${valid.length} previously downloaded ${saved.value.color.toUpperCase()} tickets. Cross-color checks need a network connection.`
                    : "The saved device has no cached tickets. Connect to the network and refresh the ticket list before admitting guests.",
                });
              }
            }
          } else {
            const valid = await scannerStore.getAll("valid");
            setDevice(saved.value);
            deviceRef.current = saved.value;
            setReady(true);
            setStatus({
              kind: valid.length ? "idle" : "warn",
              title: valid.length ? "Offline scanner ready" : "No offline tickets cached",
              detail: `Using ${valid.length} previously downloaded ${saved.value.color.toUpperCase()} tickets. Cross-color checks need a network connection.`,
            });
          }
        }
        await refreshPendingCount();
      } catch (error) {
        if (mounted) setStatus({ kind: "deny", title: "Scanner setup required", detail: error.message });
      } finally {
        if (mounted) setLoading(false);
      }
    };
    restore();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/scanner-sw.js").catch((error) => console.error("Scanner offline shell registration failed:", error));
    return () => { mounted = false; };
  }, [clearRevokedDevice, downloadHashset, refreshPendingCount]);

  const pairDevice = async (event) => {
    event.preventDefault();
    setLoading(true);
    let pairingCompleted = false;
    try {
      const response = await fetch("/api/scanner/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: pairingCode.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Pairing failed.");
      pairingCompleted = true;
      const pairedDevice = { ...result.device, token: result.token };
      const previous = await scannerStore.get("meta", "eventId");
      if (previous?.value !== pairedDevice.eventId) await scannerStore.clear("used");
      await scannerStore.clear("valid");
      await scannerStore.put("meta", { key: "device", value: pairedDevice });
      await scannerStore.put("meta", { key: "eventId", value: pairedDevice.eventId });
      setDevice(pairedDevice);
      deviceRef.current = pairedDevice;
      setReady(true);
      await downloadHashset(pairedDevice);
      setPairingCode("");
    } catch (error) {
      if (error.status === 401) {
        await clearRevokedDevice();
        setStatus({
          kind: "deny",
          title: "SCANNER REVOKED",
          detail: "This device is no longer authorized. Ask an administrator for a new pairing code.",
        });
      } else if (pairingCompleted) {
        setStatus({
          kind: "warn",
          title: "PAIRED — TICKET LIST UNAVAILABLE",
          detail: `${error.message} The pairing is saved; reconnect and refresh the ticket list to continue.`,
        });
      } else {
        setStatus({ kind: "deny", title: "Pairing failed", detail: error.message });
      }
    } finally {
      setLoading(false);
    }
  };

  const validateOnlineSession = useCallback(async (currentDevice) => {
    if (!navigator.onLine) return true;
    try {
      const response = await fetch("/api/scanner/session", {
        headers: { Authorization: `Bearer ${currentDevice.token}` },
        cache: "no-store",
      });
      if (response.status === 401) {
        await clearRevokedDevice();
        setStatus({
          kind: "deny",
          title: "SCANNER REVOKED",
          detail: "This device is no longer authorized. Ask an administrator for a new pairing code.",
        });
        return false;
      }
      if (!response.ok) return true;
      const result = await response.json();
      if (
        result.device?.eventId !== currentDevice.eventId
        || result.device?.color !== currentDevice.color
      ) {
        await clearRevokedDevice();
        setStatus({
          kind: "deny",
          title: "SCANNER DEVICE MISMATCH",
          detail: "The saved scanner does not match its server registration. Pair this device again.",
        });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }, [clearRevokedDevice]);

  const verifyCrossColor = useCallback(async (ticketId, currentDevice) => {
    if (!navigator.onLine) {
      setStatus({ kind: "warn", title: "HELP DESK — NETWORK REQUIRED", detail: `Ticket ${ticketId} is for the other color counter. Do not accept or reject it offline.` });
      return;
    }
    try {
      const response = await fetch("/api/scanner/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentDevice.token}`,
        },
        body: JSON.stringify({ ticketId }),
      });
      const result = await response.json();
      if (response.ok && result.valid) {
        setStatus({ kind: "allow", title: "ENTRY ALLOWED", detail: `Ticket ${ticketId} verified online and recorded.` });
      } else {
        setStatus({
          kind: response.status === 401 || response.status >= 500 ? "warn" : "deny",
          title: response.status === 401 || response.status >= 500 ? "HELP DESK — VERIFICATION UNAVAILABLE" : "ENTRY NOT ALLOWED",
          detail: `Ticket ${ticketId}: ${result.message || "Ticket verification failed."}`,
        });
      }
    } catch {
      setStatus({ kind: "warn", title: "HELP DESK — NETWORK REQUIRED", detail: `Could not verify ${ticketId}. Do not accept or reject it offline.` });
    }
  }, []);

  const handleCameraState = useCallback((cameraState, error) => {
    if (cameraState === "error") {
      setStatus({ kind: "deny", title: "CAMERA ERROR", detail: error || "Could not access the camera." });
    } else if (cameraState === "ready") {
      setStatus({ kind: "idle", title: "SCANNING", detail: "Camera active. Point it at a ticket QR code." });
    }
  }, []);

  const handleScanNext = useCallback(() => {
    setStatus({ kind: "idle", title: "SCANNING", detail: "Camera active. Point it at a ticket QR code." });
  }, []);

  const handleScan = useCallback(async (rawValue) => {
    const currentDevice = deviceRef.current;
    if (!currentDevice || scanLock.current) return;
    scanLock.current = true;
    setStatus({ kind: "idle", title: "SCANNING", detail: "QR detected. Checking ticket…" });
    try {
      if (!(await validateOnlineSession(currentDevice))) return;
      const ticketId = String(rawValue || "").trim();
      if (!TICKET_ID.test(ticketId)) {
        setStatus({ kind: "deny", title: "INVALID QR", detail: "The QR must contain only a valid ticket ID." });
        return;
      }
      const ticketColor = ticketId.endsWith("0") ? "red" : "blue";
      if (ticketColor !== currentDevice.color) {
        await verifyCrossColor(ticketId, currentDevice);
        return;
      }
      const valid = await scannerStore.get("valid", ticketId);
      if (!valid) {
        setStatus({ kind: "deny", title: "INVALID TICKET", detail: `Ticket ${ticketId} is not in this counter's downloaded list.` });
        return;
      }
      const used = await scannerStore.get("used", ticketId);
      if (used) {
        setStatus({ kind: "warn", title: "ALREADY SCANNED", detail: `Ticket ${ticketId} was already scanned on this device.` });
        return;
      }
      await scannerStore.put("used", { id: ticketId, at: new Date().toISOString(), synced: false });
      await refreshPendingCount();
      setStatus({ kind: "allow", title: "ENTRY ALLOWED", detail: `Ticket ${ticketId} verified offline against this counter's ticket list.` });
    } catch (error) {
      setStatus({ kind: "deny", title: "SCAN ERROR", detail: error.message });
    } finally {
      scanLock.current = false;
    }
  }, [refreshPendingCount, validateOnlineSession, verifyCrossColor]);

  const syncUsedTickets = async () => {
    if (!device || !navigator.onLine) {
      setStatus({ kind: "warn", title: "SYNC NEEDS NETWORK", detail: "Local scans remain saved on this device and can be synchronized when online." });
      return;
    }
    try {
      const local = (await scannerStore.getAll("used")).filter((ticket) => !ticket.synced);
      if (!local.length) {
        setStatus({ kind: "idle", title: "Already synchronized", detail: "There are no pending local scans." });
        return;
      }
      const response = await fetch("/api/scanner/sync-used", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${device.token}`,
        },
        body: JSON.stringify({ ticketIds: local.map((ticket) => ticket.id) }),
      });
      const result = await response.json();
      if (response.status === 401) {
        await clearRevokedDevice();
        setStatus({
          kind: "deny",
          title: "SCANNER REVOKED",
          detail: "This device is no longer authorized. Ask an administrator for a new pairing code.",
        });
        return;
      }
      if (!response.ok) throw new Error(result.message || "Scan synchronization failed.");
      const unresolved = [];
      for (const item of result.results) {
        if (item.status === "synced" || item.status === "already-synced") {
          const stored = await scannerStore.get("used", item.ticketId);
          await scannerStore.put("used", { ...stored, synced: true });
        } else {
          unresolved.push(item.ticketId);
        }
      }
      await refreshPendingCount();
      setStatus({
        kind: unresolved.length ? "warn" : "allow",
        title: unresolved.length ? "SYNC NEEDS REVIEW" : "SYNC COMPLETE",
        detail: unresolved.length ? `${unresolved.length} local scans need Help Desk reconciliation.` : `${local.length} locally used tickets synchronized.`,
      });
    } catch (error) {
      setStatus({ kind: "warn", title: "SYNC FAILED", detail: error.message });
    }
  };

  const refreshTicketList = async () => {
    if (!device || !navigator.onLine) {
      setStatus({ kind: "warn", title: "REFRESH NEEDS NETWORK", detail: "Connect to the network to download the latest ticket list." });
      return;
    }
    try {
      await downloadHashset(device);
    } catch (error) {
      if (error.status === 401) {
        await clearRevokedDevice();
        setStatus({
          kind: "deny",
          title: "SCANNER REVOKED",
          detail: "This device is no longer authorized. Ask an administrator for a new pairing code.",
        });
        return;
      }
      setStatus({ kind: "warn", title: "REFRESH FAILED", detail: error.message });
    }
  };

  const resetDevice = async () => {
    if (!window.confirm("Unpair this scanner and erase its offline ticket and scan data?")) return;
    await Promise.all([scannerStore.clear("valid"), scannerStore.clear("used"), scannerStore.clear("meta")]);
    deviceRef.current = null;
    setDevice(null);
    setReady(false);
    setPendingSync(0);
    setStatus({ kind: "idle", title: "Scanner unpaired", detail: "Ask an administrator for a new single-use pairing code." });
  };

  if (loading && !ready) return <main className="min-h-screen grid place-items-center bg-[#0f0f1a] text-white">Loading scanner…</main>;

  return (
    <main className="min-h-screen bg-[#0f0f1a] px-4 py-8 text-white">
      <section className="mx-auto w-full max-w-xl">
        {!ready ? (
          <div className="rounded-2xl bg-[#1e1e30] p-6 shadow-xl">
            <h1 className="text-2xl font-bold">Ticket Scanner Setup</h1>
            <p className="mt-2 text-sm text-gray-300">Use a single-use pairing code from the admin Events page. This downloads only that device’s event and color ticket list.</p>
            <form className="mt-6 space-y-3" onSubmit={pairDevice}>
              <label className="block text-sm font-medium" htmlFor="pairing-code">Pairing code</label>
              <input id="pairing-code" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)}
                autoComplete="one-time-code" required className="w-full rounded-lg border border-gray-600 bg-[#11111e] px-3 py-3 text-white" />
              <button disabled={loading} className="w-full rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-50">
                {loading ? "Pairing…" : "Pair and download tickets"}
              </button>
            </form>
            <p className="mt-4 text-sm text-gray-300">{status.detail}</p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <span className={`rounded-full px-4 py-2 text-sm font-bold uppercase ${device.color === "red" ? "bg-red-700" : "bg-blue-700"}`}>
                {device.color} counter · {device.eventId}
              </span>
              <span className="text-sm text-gray-300">{pendingSync} scans pending sync</span>
            </div>
            <div className="rounded-2xl bg-black p-2"><QrScanner onScan={handleScan} onCameraState={handleCameraState} onScanNext={handleScanNext} /></div>
            <div className={`mt-4 min-h-28 rounded-2xl p-5 text-center ${status.kind === "allow" ? "bg-green-800" : status.kind === "deny" ? "bg-red-800" : status.kind === "warn" ? "bg-amber-700" : "bg-[#1e1e30]"}`}>
              <h2 className="text-xl font-bold">{status.title}</h2>
              <p className="mt-2 text-sm">{status.detail}</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button onClick={syncUsedTickets} className="rounded-lg border border-gray-500 px-3 py-3 text-sm">Sync local scans</button>
              <button onClick={refreshTicketList} className="rounded-lg border border-gray-500 px-3 py-3 text-sm">Refresh ticket list</button>
              <button onClick={resetDevice} className="col-span-2 rounded-lg border border-gray-500 px-3 py-3 text-sm">Unpair device</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
