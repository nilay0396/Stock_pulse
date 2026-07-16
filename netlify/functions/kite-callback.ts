import { exchangeAndPersistKiteRequestToken } from "./lib/kite/auth.js";

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const requestToken = url.searchParams.get("request_token");
  const status = url.searchParams.get("status");

  if (status && status !== "success") {
    return redirect(`/?kite_token=failed&reason=${encodeURIComponent(status)}`);
  }

  if (!requestToken) {
    return new Response("Missing request_token", { status: 400 });
  }

  try {
    const result = await exchangeAndPersistKiteRequestToken(requestToken);
    return redirect(`/?kite_token=success&refreshed_at=${encodeURIComponent(result.refreshedAt)}`);
  } catch (err) {
    console.error("kite-callback: failed", err instanceof Error ? err.message : err);
    return redirect(`/?kite_token=failed`);
  }
};
