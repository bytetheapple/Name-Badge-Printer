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
import QrCode from './routes/admin/QrCode'
import Settings from './routes/admin/Settings'
import Members from './routes/admin/Members'

const router = createBrowserRouter([
  { path: '/', element: <PublicForm /> },
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
      { path: 'qr', element: <QrCode /> },
      { path: 'settings', element: <Settings /> },
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
