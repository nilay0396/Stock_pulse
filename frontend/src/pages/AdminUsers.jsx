import { useEffect, useState } from "react";
import { toast } from "sonner";
import api from "../lib/api";
import { fmtDate } from "../lib/fmt";

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get("/admin/users"); setUsers(data); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setRole = async (id, role) => {
    try { await api.post(`/admin/users/${id}/role`, { role }); toast.success("Role updated"); await load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };
  const resetPw = async (id) => {
    const pw = prompt("New password (min 6 chars):");
    if (!pw) return;
    try { await api.post(`/admin/users/${id}/reset-password`, { password: pw }); toast.success("Password reset"); }
    catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Admin</div>
        <h1 className="font-heading text-3xl">Users</h1>
      </header>
      <div className="panel overflow-x-auto" data-testid="users-table">
        <table className="w-full data-table">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Telegram</th><th>Email alerts</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-bold">{u.email}</td>
                <td className="font-body text-[12px]">{u.name}</td>
                <td>
                  <select className="input max-w-[110px]" value={u.role} onChange={(e) => setRole(u.id, e.target.value)} data-testid={`role-${u.id}`}>
                    <option value="user">user</option><option value="admin">admin</option>
                  </select>
                </td>
                <td className="font-mono text-[11px]">{u.preferences?.telegram_chat_id || "—"}</td>
                <td>{u.preferences?.email_alerts === false ? "off" : "on"}</td>
                <td>{fmtDate(u.created_at)}</td>
                <td><button className="btn btn-ghost" onClick={() => resetPw(u.id)} data-testid={`reset-${u.id}`}>Reset PW</button></td>
              </tr>
            ))}
            {!loading && users.length === 0 && <tr><td colSpan={7} className="text-center py-6" style={{ color: "var(--text-muted)" }}>No users</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
