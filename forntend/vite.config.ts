import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Solana / wallet stack expects Node's `buffer`; Vite otherwise externalizes it and breaks at runtime
      buffer: "buffer",
    },
  },
})
