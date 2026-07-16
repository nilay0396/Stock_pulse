import { Hono } from "hono";
import { handle } from "hono/netlify";
import { authRoutes } from "./routes/auth.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { stocksRoutes } from "./routes/stocks.js";
import { healthRoutes } from "./routes/health.js";
import { reportsRoutes } from "./routes/reports.js";
import { tradeIdeasRoutes } from "./routes/tradeIdeas.js";
import { macroRoutes } from "./routes/macro.js";
import { newsRoutes } from "./routes/news.js";
import { flowsRoutes } from "./routes/flows.js";

const app = new Hono().basePath("/api");

app.route("/", healthRoutes);
app.route("/auth", authRoutes);
app.route("/preferences", preferencesRoutes);
app.route("/stocks", stocksRoutes);
app.route("/reports", reportsRoutes);
app.route("/ideas", tradeIdeasRoutes);
app.route("/macro", macroRoutes);
app.route("/news", newsRoutes);
app.route("/flows", flowsRoutes);

app.get("/", (c) => c.json({ name: "Market Pulse India API", status: "ok" }));

app.notFound((c) => c.json({ detail: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ detail: "Internal server error" }, 500);
});

export default handle(app);
