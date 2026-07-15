import axios from "axios";

// Empty/unset REACT_APP_BACKEND_URL means "same origin" (Netlify serves the
// frontend and /api/* redirects to Netlify Functions from the same domain).
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
export const API_BASE = `${BACKEND_URL}/api`;

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("mp_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      const onLogin = window.location.pathname.startsWith("/login") ||
                      window.location.pathname.startsWith("/register");
      if (!onLogin) {
        localStorage.removeItem("mp_token");
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
