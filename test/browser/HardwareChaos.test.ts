import { expect } from '@playwright/test';
import { selectedHardwareTest } from './BrowserHardware.js';

selectedHardwareTest('reads flash through Chaos loader on hardware', 240_000, async page => {
	const result = await page.evaluate(() => window.browserUSBTest.runChaos());
	expect(result.bytesRead).toBe(1024 * 1024);
	expect(result.distinctBytes).toBeGreaterThan(1);
});
