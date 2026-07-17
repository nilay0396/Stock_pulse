import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "./lib/auth";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import TradeIdeas from "./pages/TradeIdeas";
import StockExplorer from "./pages/StockExplorer";
import StockDetail from "./pages/StockDetail";
import StockDeepDive from "./pages/StockDeepDive";
import Macro from "./pages/Macro";
import Flows from "./pages/Flows";
import News from "./pages/News";
import ReportHistory from "./pages/ReportHistory";
import ReportPreview from "./pages/ReportPreview";
import DeliveryLogs from "./pages/DeliveryLogs";
import Backtests from "./pages/Backtests";
import Preferences from "./pages/Preferences";
import AdminConnectors from "./pages/AdminConnectors";
import AdminSettings from "./pages/AdminSettings";
import AdminUsers from "./pages/AdminUsers";
import AdminLogs from "./pages/AdminLogs";

function App() {
  return (
    <AuthProvider>
      <Toaster theme="dark" richColors position="top-right" />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ideas" element={<TradeIdeas />} />
            <Route path="/explorer" element={<StockExplorer />} />
            <Route path="/explorer/:symbol" element={<StockDetail />} />
            <Route path="/deep-dive" element={<StockDeepDive />} />
            <Route path="/macro" element={<Macro />} />
            <Route path="/flows" element={<Flows />} />
            <Route path="/news" element={<News />} />
            <Route path="/reports" element={<ReportHistory />} />
            <Route path="/history" element={<ReportHistory />} />
            <Route path="/reports/:runId" element={<ReportPreview />} />
            <Route path="/deliveries" element={<DeliveryLogs />} />
            <Route path="/backtests" element={<Backtests />} />
            <Route path="/preferences" element={<Preferences />} />

            <Route path="/admin/connectors" element={<ProtectedRoute adminOnly><AdminConnectors /></ProtectedRoute>} />
            <Route path="/admin/settings" element={<ProtectedRoute adminOnly><AdminSettings /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
            <Route path="/admin/logs" element={<ProtectedRoute adminOnly><AdminLogs /></ProtectedRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
