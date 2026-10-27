import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  server: {
    port: 3000,
    host: true,
    https: false,
   headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-onnx': ['onnxruntime-web'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@supabase/supabase-js', 'onnxruntime-web'],
    esbuildOptions: {
      target: 'es2022',
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',                    // ← NUEVO: registra el SW automáticamente
      includeAssets: [
        'favicon.svg',
        'icon-192.svg',
        'icon-512.svg',
        'models/**/*',                            // ← NUEVO: precachear modelos
      ],
      manifest: {
        name: 'PlateDetect',
        short_name: 'PlateDetect',
        description: 'Lector de patentes en vivo con detección de vehículos registrados y denunciados',
        theme_color: '#3b82f6',
        background_color: '#0b1121',
        display: 'standalone',
        orientation: 'portrait',
        scope: './',                                // ← CAMBIO: relativo
        start_url: './',                            // ← CAMBIO: relativo
        icons: [
          { src: 'icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: 'icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,onnx,txt}'],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  esbuild: {
    target: 'es2022',
  },
});