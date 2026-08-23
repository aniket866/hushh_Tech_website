import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// Read version from package.json at build time
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Capture git commit hash at build time for deployment verification
const gitCommitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
})()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
    __GIT_COMMIT__: JSON.stringify(gitCommitHash),
  },
  plugins: [
    react(),
    mdx({
      // ensure MDX compiles to React JSX
      jsxImportSource: 'react',
      providerImportSource: '@mdx-js/react',
      remarkPlugins: [remarkFrontmatter, remarkGfm],
      rehypePlugins: [rehypeSlug],
      // optional: treat .md files as MDX too
      // format: 'detect'
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2017',
    chunkSizeWarningLimit: 5000,
    // Security: Strip ALL console statements in production builds
    // Prevents exposure of tokens, financial data, and internal logs
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,     // Remove console.log, warn, error, etc.
        drop_debugger: true,    // Remove debugger statements
        pure_funcs: ['console.log', 'console.warn', 'console.info', 'console.debug'],
      },
      format: {
        comments: false,        // Remove all comments from output
      },
    },
  },
  server: {
    proxy: {
      // Forward API calls to the serverless host in dev (vercel dev runs on 3000 by default)
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        bypass: (req) => (req.url?.startsWith('/api/shared/') ? req.url : undefined),
      },
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mdx'],
  },
})
