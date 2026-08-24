import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './lib/auth'
import { OrgProvider } from './lib/org'
import { RequireAuth } from './components/RequireAuth'
import PublicForm from './routes/PublicForm'
import Login from './routes/admin/Login'
import SetPassword from './routes/admin/SetPassword'
import AdminLayout from './routes/admin/AdminLayout'
import EntriesTable from './routes/admin/EntriesTable'
import StatusPanel from './routes/admin/StatusPanel'
import PrinterConfig from './routes/admin/PrinterConfig'
import Settings from './routes/admin/Settings'
import Members from './routes/admin/Members'
import IntegrationsPage from './routes/admin/IntegrationsPage'

const router = createBrowserRouter([
  { path: '/', element: <PublicForm /> },
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
