import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import PublicForm from './routes/PublicForm'
import AdminHome from './routes/admin/AdminHome'

const router = createBrowserRouter([
  { path: '/', element: <PublicForm /> },
  { path: '/admin', element: <AdminHome /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
