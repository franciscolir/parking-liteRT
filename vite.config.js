import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  server: {
    port: 3000,
    host: true,
    https: false, // mkcert se encarga si está disponible
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
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
    mkcert(), // Genera certificados SSL locales automáticamente
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