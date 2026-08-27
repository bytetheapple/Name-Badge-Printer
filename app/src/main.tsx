import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './lib/auth'
import { OrgProvider } from './lib/org'
import { RequireAuth } from './components/RequireAuth'
import { useSearchParams } from 'react-router-dom'
import PublicForm from './routes/PublicForm'
import Landing from './routes/public/Landing'
import Privacy from './routes/public/Privacy'
import Terms from './routes/public/Terms'
import Login from './routes/admin/Login'
import SetPassword from './routes/admin/SetPassword'
import AdminLayout from './routes/admin/AdminLayout'
import EntriesTable from './routes/admin/EntriesTable'
import StatusPanel from './routes/admin/StatusPanel'
import PrinterConfig from './routes/admin/PrinterConfig'
import Settings from './routes/admin/Settings'
import Members from './routes/admin/Members'
import IntegrationsPage from './routes/admin/IntegrationsPage'
import OpsOrganizations from './routes/admin/ops/Organizations'
import OpsFleet from './routes/admin/ops/Fleet'
import OpsOperators from './routes/admin/ops/Operators'
import OpsActivity from './routes/admin/ops/Activity'

/**
 * What `/` serves.
 *
 * The kiosk form owned this path outright, because the original QR codes were
 * `/?printer=<uuid>` and some are still hanging in lobbies. Those keep working
 * — the form still answers whenever a printer is named. Everyone else, which
 * now includes anyone who simply types the domain, gets the landing page.
 */
function Root() {
  const [searchParams] = useSearchParams()
  return searchParams.get('printer') ? <PublicForm /> : <Landing />
}

const router = createBrowserRouter([
  { path: '/', element: <Root /> },
  { path: '/privacy', element: <Privacy /> },
  { path: '/terms', element: <Terms /> },
  // Opaque per-printer kiosk link, encoded in the lobby QR code.
  { path: '/k/:token', element: <PublicForm /> },
  { path: '/admin/login', element: <Login /> },
  { path: '/admin/set-password', element: <SetPassword /> },
  {
    path: '/admin',
    element: (
      <RequireAuth>
        <AdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/admin/entries" replace /> },
      { path: 'entries', element: <EntriesTable /> },
      { path: 'status', element: <StatusPanel /> },
      { path: 'config', element: <PrinterConfig /> },
      { path: 'settings', element: <Settings /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'members', element: <Members /> },
      // Operations: the cross-tenant context, reached from the switcher
      // rather than from this nav. Its own tabs, because none of the ones
      // above mean anything without an organization.
      { path: 'ops', element: <Navigate to="/admin/ops/organizations" replace /> },
      { path: 'ops/organizations', element: <OpsOrganizations /> },
      { path: 'ops/fleet', element: <OpsFleet /> },
      { path: 'ops/operators', element: <OpsOperators /> },
      { path: 'ops/activity', element: <OpsActivity /> },
      // Where the console used to live; bookmarks and browser history still
      // point at it.
      { path: 'platform', element: <Navigate to="/admin/ops/organizations" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <OrgProvider>
        <RouterProvider router={router} />
      </OrgProvider>
    </AuthProvider>
  </StrictMode>,
)
