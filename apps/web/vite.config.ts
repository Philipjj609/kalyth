import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

const API_TARGET = process.env.KALYTH_API_URL ?? 'http://127.0.0.1:4317'
const DEV_PORT = Number(process.env.KALYTH_WEB_PORT ?? 5173)
const DEV_ORIGINS = new Set([`http://127.0.0.1:${DEV_PORT}`, `http://localhost:${DEV_PORT}`])

// The API checks Host and Origin. changeOrigin rewrites Host to the API's; requests from this dev
// server's own origin get the API's origin, and any other origin is passed through unchanged so
// the API still refuses it.
const toServer: ProxyOptions = {
  target: API_TARGET,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq, req) => {
      const origin = req.headers.origin
      if (origin !== undefined && DEV_ORIGINS.has(origin)) {
        proxyReq.setHeader('origin', new URL(API_TARGET).origin)
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': toServer,
      // The Handoff view tells agents to connect to <page origin>/mcp; in development that is
      // this server, so the MCP endpoint is forwarded too.
      '/mcp': toServer,
    },
  },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 700,
  },
})
