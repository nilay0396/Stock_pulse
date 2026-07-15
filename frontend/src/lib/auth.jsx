import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "./api";

const AuthCtx = createContext(null);

const CACHED_USER_KEY = "mp_user";

function readCachedUser() {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function AuthProvider({ children }) {
  // Optimistic hydration: if we have a token + cached user, render instantly
  // and revalidate with /auth/me in the background. Prevents the full-screen
  // "Loading…" overlay that blocked every navigation.
  const initialToken = typeof window !== "undefined" ? localStorage.getItem("mp_token") : null;
  const initialUser = initialToken ? readCachedUser() : null;
  const [user, setUser] = useState(initialUser);
  const [loading, setLoading] = useState(!initialUser && !!initialToken);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem("mp_token");
    if (!token) { setUser(null); setLoading(false); return; }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
      try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(data)); }
      catch (err) { console.debug("[auth] cache user persist failed", err); }
    } catch {
      localStorage.removeItem("mp_token");
      localStorage.removeItem(CACHED_USER_KEY);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    localStorage.setItem("mp_token", data.access_token);
    try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(data.user)); }
    catch (err) { console.debug("[auth] cache user on login failed", err); }
    setUser(data.user);
    return data.user;
  };

  const register = async (email, password, name) => {
    const { data } = await api.post("/auth/register", { email, password, name });
    localStorage.setItem("mp_token", data.access_token);
    try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(data.user)); }
    catch (err) { console.debug("[auth] cache user on register failed", err); }
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem("mp_token");
    localStorage.removeItem(CACHED_USER_KEY);
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, register, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}
