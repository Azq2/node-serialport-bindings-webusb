import { expect } from '@playwright/test';
import { selectedHardwareTest } from './BrowserHardware.js';

selectedHardwareTest('exchanges AT commands on hardware', 60_000, async page => {
	expect(await page.evaluate(() => window.browserUSBTest.runAT())).toHaveLength(8);
});
