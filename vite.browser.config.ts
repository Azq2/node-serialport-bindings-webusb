import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: 'test/browser/app',
	optimizeDeps: {
		exclude: ['browser-process-base'],
		include: ['@serialport/stream', '@sie-js/serial'],
	},
	resolve: {
		alias: {
			'vite-plugin-node-polyfills/shims/process': fileURLToPath(new URL('./test/browser/polyfills/process.ts', import.meta.url)),
			'browser-process-base': fileURLToPath(import.meta.resolve('vite-plugin-node-polyfills/shims/process')),
		},
	},
	plugins: [
		nodePolyfills({
			include: ['buffer', 'events', 'process', 'stream', 'util'],
			globals: {
				Buffer: true,
				global: true,
				process: true,
			},
		}),
	],
	server: {
			headers: {
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
			},
		host: '127.0.0.1',
		port: 4173,
		strictPort: true,
	},
});
