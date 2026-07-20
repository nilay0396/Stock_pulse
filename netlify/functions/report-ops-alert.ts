import type { Handler } from "@netlify/functions";
import { sendOpsAlert } from "./lib/delivery/opsAlert.js";

function json(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function authorized(headers: Record<string, string | undefined>): boolean {
  const expected = process.env.REPORT_BACKUP_SECRET || "";
  const supplied = headers["x-scheduler-secret"] || headers["x-backup-secret"] || "";
  return Boolean(expected && supplied && supplied === expected);
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { detail: "Method not allowed" });
  if (!authorized(event.headers as Record<string, string | undefined>)) return json(401, { detail: "Unauthorized" });

  const body = JSON.parse(event.body || "{}") as Record<string, unknown>;
  const subject = String(body.subject || "Operational alert");
  const message = String(body.message || "No details provided.");
  await sendOpsAlert(subject, message);
  return json(200, { ok: true });
};
