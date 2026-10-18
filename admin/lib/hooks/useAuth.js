"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export function useAuth() {
  const router = useRouter();
  const pathname = usePathname();
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const verifyAuth = async () => {
      try {
        // Try access token first
        const res = await fetch("/api/auth/me");

        if (res.ok) {
          const data = await res.json();
          setAdmin(data.admin);
          if (data.admin.role === "qr_admin" && pathname !== "/scanner") {
            router.replace("/scanner");
          } else if (pathname === "/admin/accounts" && data.admin.role !== "super_admin") {
            router.replace("/guidelines");
          }
          setLoading(false);
          return;
        }

        // Access token expired (401) — try refresh token
        if (res.status === 401) {
          const refreshRes = await fetch("/api/auth/refresh", { method: "POST" });

          if (refreshRes.ok) {
            const data = await refreshRes.json();
            setAdmin(data.admin);
            setLoading(false);
            return;
          }
        }

        // Both failed — redirect to login
        router.push("/login");
      } catch {
        router.push("/login");
      }
    };

    verifyAuth();
  }, [pathname, router]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAdmin(null);
    router.push("/login");
  };

  return { admin, loading, logout };
}
