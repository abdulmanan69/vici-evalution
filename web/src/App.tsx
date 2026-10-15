import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { QueuePage } from './pages/Queue';
import { TransferDetailPage } from './pages/TransferDetail';
import { FormsPage } from './pages/Forms';
import { FormBuilderPage } from './pages/FormBuilder';
import { EvaluationPage } from './pages/Evaluation';
import { EvaluationsListPage } from './pages/EvaluationsList';
import { AgentReportPage } from './pages/AgentReport';
import { QaTeamPage } from './pages/QaTeam';
import { QaTasksPage } from './pages/QaTasks';
import { QaPerformancePage } from './pages/QaPerformance';
import { CompaniesPage } from './pages/admin/Companies';
import { DialersPage } from './pages/admin/Dialers';
import { AgentsPage } from './pages/admin/Agents';
import { DispositionsPage } from './pages/admin/Dispositions';
import { UsersPage } from './pages/admin/Users';
import { SyncMonitorPage } from './pages/admin/SyncMonitor';
import { AuditLogsPage } from './pages/admin/AuditLogs';

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-2">Loading…</div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <Protected>
            <Layout>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/queues/:status" element={<QueuePage />} />
                <Route path="/transfers/:id" element={<TransferDetailPage />} />
                <Route path="/qa/forms" element={<FormsPage />} />
                <Route path="/qa/forms/:id" element={<FormBuilderPage />} />
                <Route path="/qa/evaluations" element={<EvaluationsListPage />} />
                <Route path="/reports/agents" element={<AgentReportPage />} />
                <Route path="/qa/team" element={<QaTeamPage />} />
                <Route path="/qa/tasks" element={<QaTasksPage />} />
                <Route path="/reports/qa" element={<QaPerformancePage />} />
                <Route path="/qa/evaluations/:id" element={<EvaluationPage />} />
                <Route path="/admin/companies" element={<CompaniesPage />} />
                <Route path="/admin/dialers" element={<DialersPage />} />
                <Route path="/admin/agents" element={<AgentsPage />} />
                <Route path="/admin/dispositions" element={<DispositionsPage />} />
                <Route path="/admin/users" element={<UsersPage />} />
                <Route path="/admin/sync" element={<SyncMonitorPage />} />
                <Route path="/admin/audit" element={<AuditLogsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </Protected>
        }
      />
    </Routes>
  );
}
