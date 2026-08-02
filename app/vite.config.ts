import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to IPv4 loopback so `localhost:5173` works in Safari (which resolves
    // localhost to 127.0.0.1). Without this, Vite may bind IPv6-only ([::1]).
    host: '127.0.0.1',
    port: 5173,
  },
})
