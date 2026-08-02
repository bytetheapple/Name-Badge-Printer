import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './lib/auth'
import { RequireAuth } from './components/RequireAuth'
import PublicForm from './routes/PublicForm'
import Login from './routes/admin/Login'
import SetPassword from './routes/admin/SetPassword'
import AdminLayout from './routes/admin/AdminLayout'
import EntriesTable from './routes/admin/EntriesTable'
import PrinterConfig from './routes/admin/PrinterConfig'

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
      { path: 'config', element: <PrinterConfig /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
)
