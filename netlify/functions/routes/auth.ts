import { Hono } from "hono";
import { db } from "../lib/db.js";
import {
  createToken,
  hashPassword,
  passwordComplexityError,
  requireUser,
  userToPublic,
  verifyPassword,
} from "../lib/auth.js";

type Variables = { user: ReturnType<typeof userToPublic> };
export const authRoutes = new Hono<{ Variables: Variables }>();

authRoutes.post("/register", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || password.length < 8 || password.length > 72) {
    return c.json({ detail: "Invalid email or password (8-72 chars)" }, 400);
  }
  const complexityErr = passwordComplexityError(password);
  if (complexityErr) return c.json({ detail: complexityErr }, 400);

  const { data: existing, error: lookupError } = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (lookupError) {
    console.error("register: lookup failed", lookupError);
    return c.json({ detail: "Registration failed" }, 500);
  }
  if (existing) return c.json({ detail: "Email already registered" }, 409);

  const name = (body.name || email.split("@")[0]).trim();
  const passwordHash = await hashPassword(password);

  const { data: user, error } = await db
    .from("users")
    .insert({ email, name, role: "user", password_hash: passwordHash })
    .select("id, email, name, role, created_at")
    .single();

  if (error || !user) {
    console.error("register: insert failed", error);
    return c.json({ detail: "Registration failed" }, 500);
  }

  const token = createToken(user.id, user.role);
  return c.json({ access_token: token, token_type: "bearer", user: userToPublic(user) });
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  const { data: user, error } = await db
    .from("users")
    .select("id, email, name, role, created_at, password_hash")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("login: lookup failed", error);
    return c.json({ detail: "Login failed" }, 500);
  }

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ detail: "Invalid credentials" }, 401);
  }

  const token = createToken(user.id, user.role);
  return c.json({ access_token: token, token_type: "bearer", user: userToPublic(user) });
});

authRoutes.get("/me", requireUser, async (c) => {
  return c.json(c.get("user"));
});

authRoutes.post("/change-password", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ current_password?: string; new_password?: string }>();
  const newPassword = body.new_password || "";

  if (newPassword.length < 8 || newPassword.length > 72) {
    return c.json({ detail: "New password must be 8-72 characters" }, 400);
  }
  const complexityErr = passwordComplexityError(newPassword);
  if (complexityErr) return c.json({ detail: complexityErr }, 400);

  const { data: dbUser } = await db
    .from("users")
    .select("password_hash")
    .eq("id", user.id)
    .maybeSingle();

  if (!dbUser || !(await verifyPassword(body.current_password || "", dbUser.password_hash))) {
    return c.json({ detail: "Current password is incorrect" }, 400);
  }

  const newHash = await hashPassword(newPassword);
  await db.from("users").update({ password_hash: newHash }).eq("id", user.id);

  return c.json({ ok: true });
});
