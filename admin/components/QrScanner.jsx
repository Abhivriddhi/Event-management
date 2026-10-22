"use client";

import { Html5Qrcode } from "html5-qrcode";
import { useEffect, useId, useRef, useState } from "react";

let cameraLifecycle = Promise.resolve();

const QrCodeScanner = ({ onScan, onCameraState, onScanNext }) => {
  const readerId = `reader-${useId().replace(/:/g, "")}`;
  const [cameraError, setCameraError] = useState("");
  const [cameraStatus, setCameraStatus] = useState("CAMERA STARTING");
  const [detectionError, setDetectionError] = useState("");
  const [restartCount, setRestartCount] = useState(0);
  const [awaitingNextScan, setAwaitingNextScan] = useState(false);
  const onScanRef = useRef(onScan);
  const onCameraStateRef = useRef(onCameraState);
  const onScanNextRef = useRef(onScanNext);
  const resumeScannerRef = useRef(null);
  const cooldownRef = useRef(false);

  onScanRef.current = onScan;
  onCameraStateRef.current = onCameraState;
  onScanNextRef.current = onScanNext;

  useEffect(() => {
    let cancelled = false;
    let scanner;
    let startPromise;
    let resumeScanner;
    let scannerPaused = false;
    const notifyCameraState = (state, error) => onCameraStateRef.current?.(state, error);
    const setStatus = (status) => {
      if (!cancelled) setCameraStatus(status);
    };

    const startScanner = async () => {
      try {
        await cameraLifecycle;
        if (cancelled) return;
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Your browser does not support camera access.");
        }

        setCameraError("");
        setDetectionError("");
        setStatus("CAMERA STARTING");
        notifyCameraState("starting");
        scanner = new Html5Qrcode(readerId);
        const config = { fps: 10 };
        resumeScanner = () => {
          if (cancelled) return;
          try {
            if (scannerPaused) scanner.resume();
            scannerPaused = false;
            cooldownRef.current = false;
            setAwaitingNextScan(false);
            setStatus("CAMERA ACTIVE — LOOKING FOR QR");
            setDetectionError("");
            onScanNextRef.current?.();
          } catch (error) {
            console.error("Failed to resume QR scanning:", error);
            setDetectionError(error.message || String(error));
            setStatus("QR DETECTION ERROR");
          }
        };
        resumeScannerRef.current = resumeScanner;
        startPromise = scanner.start(
          { facingMode: "environment" },
          config,
          (decodedText) => {
            if (cancelled || cooldownRef.current) return;
            console.log("[QR DETECTED]", decodedText);
            cooldownRef.current = true;
            setAwaitingNextScan(true);
            setStatus("QR DETECTED — REVIEW RESULT, THEN SCAN NEXT");
            setDetectionError("");
            try {
              scanner.pause();
              scannerPaused = true;
            } catch (error) {
              console.error("Failed to pause QR scanning:", error);
              setDetectionError(error.message || String(error));
              setStatus("QR DETECTION ERROR");
            }
            try {
              Promise.resolve(onScanRef.current(decodedText)).catch((error) => {
                console.error("QR scan callback failed:", error);
                if (!cancelled) {
                  setDetectionError(error.message || String(error));
                  setStatus("QR DETECTION ERROR");
                }
              });
            } catch (error) {
              console.error("QR scan callback failed:", error);
              setDetectionError(error.message || String(error));
              setStatus("QR DETECTION ERROR");
            }
          },
          () => {}
        );
        await startPromise;
        if (cancelled) return;

        const video = document.getElementById(readerId)?.querySelector("video");
        if (video) {
          video.style.display = "block";
          video.style.width = "100%";
          video.style.maxWidth = "100%";
          video.style.height = "auto";
          video.style.objectFit = "contain";
          video.playsInline = true;
          video.muted = true;
        }
        setStatus("CAMERA ACTIVE — LOOKING FOR QR");
        notifyCameraState("ready");
      } catch (error) {
        if (cancelled) return;
        const message = error.message || "Could not access the camera.";
        console.error("Failed to initialize scanner:", error);
        setCameraError(message);
        setStatus("CAMERA ERROR");
        notifyCameraState("error", message);
      }
    };

    startScanner();

    return () => {
      cancelled = true;
      cooldownRef.current = false;
      if (resumeScannerRef.current === resumeScanner) resumeScannerRef.current = null;

      const cleanup = (async () => {
        if (startPromise) {
          await startPromise.catch(() => {});
        }

        try {
          if (scanner) {
            await scanner.stop();
          }
        } catch (error) {
          console.error("Failed to stop scanner:", error);
        }

        try {
          scanner?.clear();
        } catch (error) {
          console.error("Failed to clear scanner:", error);
        }
      })();

      cameraLifecycle = cleanup;
    };
  }, [readerId, restartCount]);

  const restartCamera = () => {
    setCameraError("");
    setCameraStatus("CAMERA STARTING");
    setRestartCount((count) => count + 1);
  };

  return (
    <div>
      {cameraError ? (
        <div className="space-y-2 p-3 text-center text-sm text-red-200" role="alert">
          <p><strong>{cameraStatus}</strong>: {cameraError}</p>
          <button type="button" onClick={restartCamera} className="rounded-lg border border-white/50 px-3 py-2">
            Restart Camera
          </button>
        </div>
      ) : (
        <div className="px-3 py-2 text-center text-sm text-gray-200" aria-live="polite">
          <p>{cameraStatus}</p>
          {detectionError && cameraStatus === "QR DETECTION ERROR" && (
            <p className="mt-1 text-xs text-amber-200">{detectionError}</p>
          )}
        </div>
      )}
      <div id={readerId} className="w-full overflow-hidden" />
      {awaitingNextScan && (
        <div className="p-3 text-center">
          <button
            type="button"
            onClick={() => resumeScannerRef.current?.()}
            className="rounded-lg bg-white px-5 py-3 font-semibold text-black"
          >
            Scan next
          </button>
        </div>
      )}
    </div>
  );
};

export default QrCodeScanner;
