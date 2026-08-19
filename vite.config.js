import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Relative paths so the built app works from any folder or file://
  base: './',
  plugins: [react(), tailwindcss()],
  server: { host: '0.0.0.0', port: 5174, strictPort: true, allowedHosts: true, cors: true },
  preview: { host: '0.0.0.0', port: 4174, allowedHosts: true },
})
