import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TenantProvider } from './context/TenantContext';
import { SSEProvider } from './context/SSEContext';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Workflows from './pages/Workflows';
import WorkflowDetail from './pages/WorkflowDetail';
import ReviewQueue from './pages/ReviewQueue';
import DLQ from './pages/DLQ';
import Traces from './pages/Traces';
import Anomalies from './pages/Anomalies';
import Tenants from './pages/Tenants';

function AuthedApp() {
  return (
    <TenantProvider>
      <SSEProvider>
        <div style={{ display: 'flex', height: '100vh' }}>
          <Sidebar />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <TopBar />
            <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/workflows" element={<Workflows />} />
                <Route path="/workflows/:workflowId" element={<WorkflowDetail />} />
                <Route path="/review-queue" element={<ReviewQueue />} />
                <Route path="/dlq" element={<DLQ />} />
                <Route path="/traces" element={<Traces />} />
                <Route path="/anomalies" element={<Anomalies />} />
                <Route path="/tenants" element={<Tenants />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </div>
        </div>
      </SSEProvider>
    </TenantProvider>
  );
}

function Gate() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <AuthedApp /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
