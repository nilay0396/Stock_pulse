import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Context, Next } from "hono";
import { db } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const JWT_ALGORITHM = (process.env.JWT_ALGORITHM || "HS256") as jwt.Algorithm;
const JWT_EXPIRE_HOURS = Number(process.env.JWT_EXPIRE_HOURS || "168");

function jwtSecret(): string {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return JWT_SECRET;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  created_at: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hashed);
  } catch {
    return false;
  }
}

export function createToken(userId: string, role: string): string {
  return jwt.sign({ sub: userId, role }, jwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: `${JWT_EXPIRE_HOURS}h`,
  });
}

export function decodeToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, jwtSecret(), { algorithms: [JWT_ALGORITHM] }) as jwt.JwtPayload;
}

/** ≥1 letter AND ≥1 digit-or-symbol. Length is enforced by the caller (8-72). */
export function passwordComplexityError(pw: string): string | null {
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasOther = /[^a-zA-Z]/.test(pw);
  if (!(hasLetter && hasOther)) {
    return "Password must contain at least one letter and one digit or symbol";
  }
  return null;
}

export function userToPublic(u: {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  created_at?: string | null;
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    role: (u.role as "user" | "admin") || "user",
    created_at: u.created_at || new Date().toISOString(),
  };
}

type Variables = {
  user: PublicUser;
};

/** Decodes the bearer token and re-fetches the user from the DB on every
 * request (role is looked up live, never trusted from the JWT claim,
 * matching the original FastAPI dependency). Returns the public user, or
 * null if `c` was already answered with an error response. */
async function authenticate(c: Context<{ Variables: Variables }>): Promise<PublicUser | null> {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    c.res = c.json({ detail: "Not authenticated" }, 401);
    return null;
  }

  let userId: string;
  try {
    const payload = decodeToken(token);
    userId = payload.sub as string;
  } catch (err: any) {
    c.res = c.json({ detail: err?.name === "TokenExpiredError" ? "Token expired" : "Invalid token" }, 401);
    return null;
  }

  const { data: user, error } = await db
    .from("users")
    .select("id, email, name, role, created_at")
    .eq("id", userId)
    .maybeSingle();

  if (error || !user) {
    c.res = c.json({ detail: "User not found" }, 401);
    return null;
  }

  return userToPublic(user);
}

/** Hono middleware — any authenticated user. */
export async function requireUser(c: Context<{ Variables: Variables }>, next: Next) {
  const user = await authenticate(c);
  if (!user) return;
  c.set("user", user);
  await next();
}

/** Hono middleware — authenticated admin only. */
export async function requireAdmin(c: Context<{ Variables: Variables }>, next: Next) {
  const user = await authenticate(c);
  if (!user) return;
  if (user.role !== "admin") {
    c.res = c.json({ detail: "Admin privileges required" }, 403);
    return;
  }
  c.set("user", user);
  await next();
}
