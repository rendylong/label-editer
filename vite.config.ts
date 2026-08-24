import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5178 },
  preview: { port: 4178 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
