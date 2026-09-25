import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The backend (Starlette) serves /api; in dev Vite proxies to it. In production the backend serves dist/.
const backend = process.env.SMARTBOOK_BACKEND ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.SMARTBOOK_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
})
