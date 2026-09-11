import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The generation history + caption cache live in a local sidecar server
// (server/index.mjs, default port 8787), not in the browser. Same-origin via
// this proxy so the client needs no CORS and no absolute URL.
const API_PORT = process.env.PE_API_PORT || 8787
const apiProxy = {
  '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
}

// strictPort: a silent move to 5174/5175 when 5173 is busy changes the page
// origin. That used to also change which IndexedDB opened (→ "history is empty
// again"); the data is out of the browser now, but a second app instance racing
// one sidecar is still wrong — fail loudly instead.
export default defineConfig({
  plugins: [react()],
  server:  { strictPort: true, proxy: apiProxy },
  preview: { strictPort: true, proxy: apiProxy },
})
