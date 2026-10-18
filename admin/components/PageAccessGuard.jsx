"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const PUBLIC_PATHS = new Set(["/login", "/request-access", "/scanner"]);

export default function PageAccessGuard({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [verifiedPath, setVerifiedPath] = useState("");
  const [verificationError, setVerificationError] = useState("");

  useEffect(() => {
    if (PUBLIC_PATHS.has(pathname)) {
      setVerificationError("");
      setVerifiedPath(pathname);
      return;
    }

    let active = true;
    setVerifiedPath("");
    setVerificationError("");

    const verifyPageAccess = async () => {
      try {
        let response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.status === 401) {
          response = await fetch("/api/auth/refresh", { method: "POST", cache: "no-store" });
        }
        if (!response.ok) {
          if (response.status === 503 || response.status >= 500) {
            throw new Error("Unable to verify your account right now. Please retry.");
          }
          router.replace("/login");
          return;
        }

        const data = await response.json();
        if (data.admin?.role === "qr_admin") {
          router.replace("/scanner");
          return;
        }
        if (active) setVerifiedPath(pathname);
      } catch (error) {
        if (active) setVerificationError(error.message || "Unable to verify account access.");
      }
    };

    verifyPageAccess();
    return () => {
      active = false;
    };
  }, [pathname, router]);

  if (PUBLIC_PATHS.has(pathname)) return children;
  if (verifiedPath === pathname) return children;
  if (verificationError) {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <p role="alert" className="text-sm text-destructive">{verificationError}</p>
        <button className="mt-4 underline" onClick={() => setVerifiedPath("")}>Retry</button>
      </main>
    );
  }
  return null;
}
