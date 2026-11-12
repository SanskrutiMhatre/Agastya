import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireGate, RequireRole, useAuth } from './auth.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import AppShell from './components/layout/AppShell.jsx';
import SignIn from './pages/auth/SignIn.jsx';
import ForgotPassword from './pages/auth/ForgotPassword.jsx';
import { ForcedPasswordChange, Onboarding } from './pages/auth/Gates.jsx';
import AdminDashboard from './pages/dashboards/AdminDashboard.jsx';
import ManagerDashboard from './pages/dashboards/ManagerDashboard.jsx';
import AuthorDashboard from './pages/dashboards/AuthorDashboard.jsx';
import UsersPage from './pages/users/UsersPage.jsx';
import UserDetail from './pages/users/UserDetail.jsx';
import ProjectsPage from './pages/projects/ProjectsPage.jsx';
import ProjectDetail from './pages/projects/ProjectDetail.jsx';
import ProjectWorkspaceEntry from './pages/projects/ProjectWorkspaceEntry.jsx';
import WorkspacesPage from './pages/projects/WorkspacesPage.jsx';
import { NotFound } from './pages/Placeholders.jsx';
import AuditPage from './pages/admin/AuditPage.jsx';
import HealthPage from './pages/admin/HealthPage.jsx';
import BackupsPage from './pages/admin/BackupsPage.jsx';
import ApprovalsPage from './pages/approvals/ApprovalsPage.jsx';
import MyPublications from './pages/projects/MyPublications.jsx';
import MyDataModules from './pages/dms/MyDataModules.jsx';
import GraphicsLibraryPage from './pages/graphics/GraphicsLibraryPage.jsx';
import BackupPage from './pages/backup/BackupPage.jsx';
import ConverterPage from './pages/tools/ConverterPage.jsx';
import DmcCreatorPage from './pages/tools/DmcCreatorPage.jsx';
import { FullPageSpinner } from './components/ui/States.jsx';

// The data module editor carries the S1000D content models and Monaco: loaded when a module is opened.
const DmEditor = lazy(() => import('./pages/dms/DmEditor.jsx'));
const ReviewPage = lazy(() => import('./pages/approvals/ReviewPage.jsx'));

const ADMIN = 'software_admin';
const PM = 'project_manager';
const AUTHOR = 'author';

// Each role lands on its own dashboard, and only its own.
function Dashboard() {
  const { me } = useAuth();
  if (me.user.role === ADMIN) return <AdminDashboard />;
  if (me.user.role === PM) return <ManagerDashboard />;
  if (me.user.role === AUTHOR) return <AuthorDashboard />;
  return <Navigate to="/signin" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/onboarding" element={<RequireGate gate="/onboarding"><Onboarding /></RequireGate>} />
            <Route path="/change-password" element={<RequireGate gate="/change-password"><ForcedPasswordChange /></RequireGate>} />
            <Route element={<RequireAuth><AppShell /></RequireAuth>}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/:id" element={<ProjectDetail />} />
              <Route path="projects/:id/workspace" element={<ProjectWorkspaceEntry />} />
              <Route path="projects/:id/dms/:dmId" element={<Suspense fallback={<FullPageSpinner />}><DmEditor /></Suspense>} />
              <Route path="workspaces" element={<RequireRole roles={[AUTHOR]}><WorkspacesPage /></RequireRole>} />
              <Route path="graphics" element={<RequireRole roles={[AUTHOR]}><GraphicsLibraryPage /></RequireRole>} />
              <Route path="tools/converter" element={<RequireRole roles={[AUTHOR]}><ConverterPage /></RequireRole>} />
              <Route path="tools/dmc-creator" element={<RequireRole roles={[AUTHOR]}><DmcCreatorPage /></RequireRole>} />
              <Route path="backup" element={<RequireRole roles={[AUTHOR]}><BackupPage /></RequireRole>} />
              <Route path="users" element={<RequireRole roles={[ADMIN, PM]}><UsersPage /></RequireRole>} />
              <Route path="users/:id" element={<RequireRole roles={[ADMIN, PM]}><UserDetail /></RequireRole>} />
              <Route path="approvals" element={<RequireRole roles={[ADMIN, PM]}><ApprovalsPage /></RequireRole>} />
              <Route path="approvals/:reqId" element={<RequireRole roles={[ADMIN, PM]}><Suspense fallback={<FullPageSpinner />}><ReviewPage /></Suspense></RequireRole>} />
              <Route path="audit" element={<RequireRole roles={[ADMIN]}><AuditPage /></RequireRole>} />
              <Route path="health" element={<RequireRole roles={[ADMIN]}><HealthPage /></RequireRole>} />
              <Route path="backups" element={<RequireRole roles={[ADMIN]}><BackupsPage /></RequireRole>} />
              <Route path="data-modules" element={<RequireRole roles={[AUTHOR]}><MyDataModules /></RequireRole>} />
              <Route path="publications" element={<RequireRole roles={[AUTHOR]}><MyPublications /></RequireRole>} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
