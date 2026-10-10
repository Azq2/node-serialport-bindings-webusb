import { expect } from '@playwright/test';
import { hardwareTest } from './BrowserHardware.js';

hardwareTest('runs loopback and stress loopback on hardware', 120_000, async page => {
	const baudRates = await page.evaluate(() => window.browserUSBTest.loopbackBaudRates());
	for (const baudRate of baudRates) {
		const result = await page.evaluate(
			rate => window.browserUSBTest.runStressLoopback(rate),
			baudRate,
		);
		expect(result.small.bytes).toBeGreaterThan(0);
		expect(result.large.bytes).toBeGreaterThan(0);
		console.log(baudRate, result);
	}
});
