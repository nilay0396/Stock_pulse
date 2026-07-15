import { Hono } from "hono";
import { handle } from "hono/netlify";
import { authRoutes } from "./routes/auth.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { stocksRoutes } from "./routes/stocks.js";
import { healthRoutes } from "./routes/health.js";

const app = new Hono().basePath("/api");

app.route("/", healthRoutes);
app.route("/auth", authRoutes);
app.route("/preferences", preferencesRoutes);
app.route("/stocks", stocksRoutes);

app.get("/", (c) => c.json({ name: "Market Pulse India API", status: "ok" }));

app.notFound((c) => c.json({ detail: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ detail: "Internal server error" }, 500);
});

export default handle(app);
