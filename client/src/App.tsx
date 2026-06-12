import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import LoginPage from '@/components/auth/LoginPage';
import RegisterPage from '@/components/auth/RegisterPage';
import AppLayout from '@/components/layout/AppLayout';
import ChatWindow from '@/components/chat/ChatWindow';
import AdminDashboard from '@/components/admin/AdminDashboard';
import MeetingJoinPage from '@/components/calls/MeetingJoinPage';
import ForcePasswordChange from '@/components/auth/ForcePasswordChange';
import { Loader2 } from 'lucide-react';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuthStore();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={32} style={{ color: '#6264A7', animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Preserve the intended destination so LoginPage can return the user
    // there after authenticating. Used by the /meeting/:callId flow.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  // Temporary-password gate: after onboarding or an admin reset the user MUST
  // set their own password before reaching any part of the app (incl. meeting
  // links). Rendering the gate here — instead of as a route — makes it
  // impossible to bypass via URL navigation.
  if (user?.must_change_password) {
    return <ForcePasswordChange />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={32} style={{ color: '#6264A7', animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <RegisterPage />
            </PublicRoute>
          }
        />

        {/* Protected routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<ChatWindow />} />
          <Route path="chat/:conversationId" element={<ChatWindow />} />
          <Route path="admin" element={<AdminDashboard />} />
          {/* Shareable meeting link — anyone in the org with the URL can preview + join */}
          <Route path="meeting/:callId" element={<MeetingJoinPage />} />
        </Route>

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
