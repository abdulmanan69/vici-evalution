import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';

/**
 * Pages load on demand: the first visit downloads only the shell and the page
 * being opened (charts, the form builder and admin screens stay out of it).
 * The pages reviewers live in are fetched in the background right after
 * sign-in, so moving between them never waits on the network.
 */
const RELOAD_FLAG = 'qa-new-build-reload';

function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() =>
    load()
      .then((m) => {
        try {
          sessionStorage.removeItem(RELOAD_FLAG);
        } catch {
          /* storage blocked — nothing to clear */
        }
        return { default: m[name] };
      })
      .catch((err: unknown) => {
        // A deploy replaced the files this open tab knew about: reload once
        // to pick up the new build instead of showing a broken page.
        let reloaded = true;
        try {
          reloaded = sessionStorage.getItem(RELOAD_FLAG) === '1';
          if (!reloaded) sessionStorage.setItem(RELOAD_FLAG, '1');
        } catch {
          /* storage blocked — fall through to the error */
        }
        if (!reloaded) {
          window.location.reload();
          return new Promise<{ default: ComponentType }>(() => {});
        }
        throw err;
      }),
  );
}

const loadQueue = () => import('./pages/Queue');
const loadTransfer = () => import('./pages/TransferDetail');
const loadEvaluation = () => import('./pages/Evaluation');
const loadTasks = () => import('./pages/QaTasks');
const loadDashboard = () => import('./pages/Dashboard');

const DashboardPage = page(loadDashboard, 'DashboardPage');
const QueuePage = page(loadQueue, 'QueuePage');
const TransferDetailPage = page(loadTransfer, 'TransferDetailPage');
const EvaluationPage = page(loadEvaluation, 'EvaluationPage');
const QaTasksPage = page(loadTasks, 'QaTasksPage');
const FormsPage = page(() => import('./pages/Forms'), 'FormsPage');
const FormBuilderPage = page(() => import('./pages/FormBuilder'), 'FormBuilderPage');
const EvaluationsListPage = page(() => import('./pages/EvaluationsList'), 'EvaluationsListPage');
const AgentReportPage = page(() => import('./pages/AgentReport'), 'AgentReportPage');
const QaTeamPage = page(() => import('./pages/QaTeam'), 'QaTeamPage');
const QaPerformancePage = page(() => import('./pages/QaPerformance'), 'QaPerformancePage');
const CompaniesPage = page(() => import('./pages/admin/Companies'), 'CompaniesPage');
const DialersPage = page(() => import('./pages/admin/Dialers'), 'DialersPage');
const AgentsPage = page(() => import('./pages/admin/Agents'), 'AgentsPage');
const DispositionsPage = page(() => import('./pages/admin/Dispositions'), 'DispositionsPage');
const UsersPage = page(() => import('./pages/admin/Users'), 'UsersPage');
const SyncMonitorPage = page(() => import('./pages/admin/SyncMonitor'), 'SyncMonitorPage');
const AuditLogsPage = page(() => import('./pages/admin/AuditLogs'), 'AuditLogsPage');

function usePrefetchWorkPages(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const warm = () => {
      for (const load of [loadQueue, loadTransfer, loadEvaluation, loadTasks, loadDashboard]) void load().catch(() => {});
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(warm);
    else setTimeout(warm, 1500);
  }, [enabled]);
}

function PageLoading() {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ink-2" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden />
      Loading…
    </div>
  );
}

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  usePrefetchWorkPages(!!user);
  if (loading) {
    return <div className="flex h-screen items-center justify-center text-ink-2">Loading…</div>;
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
              <Suspense fallback={<PageLoading />}>
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
              </Suspense>
            </Layout>
          </Protected>
        }
      />
    </Routes>
  );
}
