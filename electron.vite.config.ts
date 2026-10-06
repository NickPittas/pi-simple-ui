import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const root = process.cwd()
const rendererRoot = resolve(root, 'src/renderer')
const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  productName: string
  version: string
}

const appDefines = {
  __APP_NAME__: JSON.stringify(packageInfo.productName),
  __APP_VERSION__: JSON.stringify(packageInfo.version),
}

export default defineConfig({
  main: {
    define: appDefines,
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    define: appDefines,
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(root, 'src/preload/index.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: rendererRoot,
    define: appDefines,
    resolve: {
      alias: {
        '@renderer': rendererRoot,
      },
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      strictPort: true,
    },
  },
})
