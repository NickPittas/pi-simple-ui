import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'vendor/**', 'out/**', 'release/**'],
    environment: 'node',
    restoreMocks: true,
  },
})
