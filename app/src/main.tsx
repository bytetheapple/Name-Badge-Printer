import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './lib/auth'
import { RequireAuth } from './components/RequireAuth'
import PublicForm from './routes/PublicForm'
import AdminHome from './routes/admin/AdminHome'
import Login from './routes/admin/Login'
import SetPassword from './routes/admin/SetPassword'

const router = createBrowserRouter([
  { path: '/', element: <PublicForm /> },
  { path: '/admin/login', element: <Login /> },
  { path: '/admin/set-password', element: <SetPassword /> },
  {
    path: '/admin',
    element: (
      <RequireAuth>
        <AdminHome />
      </RequireAuth>
    ),
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
)
