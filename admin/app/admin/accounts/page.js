"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/hooks/useAuth";

const ROLES = ["super_admin", "admin", "qr_admin"];
const EMPTY_ACCOUNT = { name: "", email: "", password: "", role: "admin" };

export default function AccountsPage() {
  const router = useRouter();
  const { admin, loading: authLoading } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [accountForm, setAccountForm] = useState(EMPTY_ACCOUNT);
  const [drafts, setDrafts] = useState({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [accountResponse, requestResponse] = await Promise.all([
      fetch("/api/admin/accounts", { cache: "no-store" }),
      fetch("/api/admin/access-requests", { cache: "no-store" }),
    ]);
    const [accountData, requestData] = await Promise.all([accountResponse.json(), requestResponse.json()]);
    if (!accountResponse.ok) throw new Error(accountData.message || "Unable to load accounts.");
    if (!requestResponse.ok) throw new Error(requestData.message || "Unable to load access requests.");
    setAccounts(accountData.accounts || []);
    setRequests(requestData.requests || []);
    setDrafts(Object.fromEntries((accountData.accounts || []).map((account) => [
      account._id,
      { role: account.role, active: account.active },
    ])));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (admin?.role !== "super_admin") {
      router.replace("/guidelines");
      return;
    }
    load().catch((error) => setNotice(error.message));
  }, [admin, authLoading, load, router]);

  const createAccount = async (event) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accountForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to create account.");
      setAccountForm(EMPTY_ACCOUNT);
      setNotice("Account created.");
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const updateAccount = async (accountId) => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(drafts[accountId]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to update account.");
      setNotice(data.sessionsRevoked ? "Account updated; its refresh sessions were revoked." : "Account updated.");
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reviewRequest = async (requestId, action, role) => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/admin/access-requests/${encodeURIComponent(requestId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, role }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to review request.");
      setNotice(`Access request ${data.status}.`);
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (authLoading || admin?.role !== "super_admin") return null;

  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-5 bg-background p-4 md:p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Account management</h1>
          <p className="text-sm text-muted-foreground">Super Admin only · role/status changes revoke refresh sessions.</p>
        </div>
        <Button variant="outline" onClick={() => router.push("/events")}>Back to events</Button>
      </header>
      {notice && <p role="status" className="rounded-md border border-border p-3 text-sm">{notice}</p>}

      <Card>
        <CardHeader><CardTitle>Create account</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createAccount} className="grid gap-3 md:grid-cols-2">
            <input required maxLength={100} placeholder="Name" value={accountForm.name}
              onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3" />
            <input required type="email" maxLength={254} placeholder="Email" value={accountForm.email}
              onChange={(event) => setAccountForm({ ...accountForm, email: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3" />
            <input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" placeholder="Temporary password (12+ characters)" value={accountForm.password}
              onChange={(event) => setAccountForm({ ...accountForm, password: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3" />
            <select value={accountForm.role} onChange={(event) => setAccountForm({ ...accountForm, role: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3">
              {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <Button type="submit" disabled={busy}>Create account</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Pending access requests</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {requests.filter((request) => request.status === "pending").map((request) => (
            <div key={request._id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <div className="min-w-56 flex-1">
                <p className="font-medium">{request.name} · {request.email}</p>
                {request.message && <p className="text-sm text-muted-foreground">{request.message}</p>}
              </div>
              <select aria-label={`Role for ${request.email}`} defaultValue="admin" id={`role-${request._id}`}
                className="h-10 rounded-md border border-input bg-background px-3">
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <Button disabled={busy} onClick={() => {
                const role = document.getElementById(`role-${request._id}`)?.value;
                reviewRequest(request._id, "approve", role);
              }}>Approve</Button>
              <Button variant="outline" disabled={busy} onClick={() => reviewRequest(request._id, "reject")}>Reject</Button>
            </div>
          ))}
          {!requests.some((request) => request.status === "pending") && <p className="text-sm text-muted-foreground">No pending requests.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Accounts</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {accounts.map((account) => (
            <div key={account._id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <div className="min-w-56 flex-1">
                <p className="font-medium">{account.name}</p>
                <p className="text-sm text-muted-foreground">{account.email}</p>
              </div>
              <select aria-label={`Role for ${account.email}`} value={drafts[account._id]?.role || account.role}
                onChange={(event) => setDrafts({ ...drafts, [account._id]: { ...drafts[account._id], role: event.target.value } })}
                className="h-10 rounded-md border border-input bg-background px-3">
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={drafts[account._id]?.active ?? account.active}
                  onChange={(event) => setDrafts({ ...drafts, [account._id]: { ...drafts[account._id], active: event.target.checked } })} />
                Active
              </label>
              <Button variant="outline" disabled={busy} onClick={() => updateAccount(account._id)}>Save</Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
