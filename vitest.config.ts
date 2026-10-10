import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		exclude: ['test/browser/**/*.test.ts'],
		fileParallelism: process.env.WEBUSB_HARDWARE !== '1',
	},
});
