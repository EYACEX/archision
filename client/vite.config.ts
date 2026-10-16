import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  // Two pages: the public 3D viewer and the agent panel.
  build: { rollupOptions: { input: { main: 'index.html', agent: 'agent.html' } } },
});
