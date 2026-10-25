import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 5173 is the evidence-feed app, 5174 its test DB variant.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // The 3D stack loads lazily after first paint; split it so the pieces download in parallel.
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei'],
          post: ['postprocessing', '@react-three/postprocessing', 'n8ao'],
        },
      },
    },
  },
});
