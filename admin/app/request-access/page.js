"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function RequestAccessPage() {
  const [form, setForm] = useState({ name: "", email: "", password: "", message: "" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/auth/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to submit access request.");
      setForm({ name: "", email: "", password: "", message: "" });
      setNotice(data.message);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Request administrator access</CardTitle>
          <p className="text-sm text-muted-foreground">A Super Admin must review your request before the account can be used.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <label className="block space-y-1 text-sm">Name
              <input required maxLength={100} value={form.name} onChange={(event) => update("name", event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="block space-y-1 text-sm">Email
              <input required type="email" maxLength={254} value={form.email} onChange={(event) => update("email", event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3" />
            </label>
            <label className="block space-y-1 text-sm">Choose a password
              <input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={form.password}
                onChange={(event) => update("password", event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3" />
              <span className="text-xs text-muted-foreground">Minimum 12 characters. It is hashed before being stored with the pending request.</span>
            </label>
            <label className="block space-y-1 text-sm">Reason for access
              <textarea maxLength={1000} rows={4} value={form.message} onChange={(event) => update("message", event.target.value)}
                className="w-full rounded-md border border-input bg-background p-3" />
            </label>
            {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit request"}</Button>
            <p className="text-sm text-muted-foreground"><Link className="underline" href="/login">Return to login</Link></p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
