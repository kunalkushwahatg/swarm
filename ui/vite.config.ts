import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  server: {
    port: 5173,
    // Proxy API requests to the Swarm coordinator in dev mode
    proxy: {
      '/health': 'http://127.0.0.1:8080',
      '/backends': 'http://127.0.0.1:8080',
      '/workers': 'http://127.0.0.1:8080',
      '/nodes': 'http://127.0.0.1:8080',
      '/metrics': 'http://127.0.0.1:8080',
      '/v1': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080',
      '/telemetry': 'http://127.0.0.1:8080',
    },
  },
})
