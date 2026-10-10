import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'test/browser',
	testMatch: '**/*.test.ts',
	outputDir: 'test-results/browser',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	use: {
		baseURL: 'http://127.0.0.1:4173',
		channel: 'chromium',
		headless: true,
	},
	webServer: {
		command: 'pnpm exec vite --config vite.browser.config.ts',
		url: 'http://127.0.0.1:4173',
		reuseExistingServer: false,
	},
});
