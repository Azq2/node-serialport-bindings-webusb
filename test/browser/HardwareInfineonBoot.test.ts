import { expect, test } from '@playwright/test';
import { hardwareTestsEnabled, infineonStopTimeoutEnabled, readHardwareWaitTimeout } from '../HardwareConfig.js';
import { INFINEON_BOOT_DEVICE } from '../InfineonBootTests.js';
import { configureHardwarePage, withHardwareBrowser } from './BrowserHardware.js';

test('reads bootcore and flash information after connect', async () => {
	test.skip(!hardwareTestsEnabled(), 'Browser hardware tests are disabled');
	test.setTimeout(readHardwareWaitTimeout() + 30_000);
	await withHardwareBrowser([INFINEON_BOOT_DEVICE], async page => {
		const errors = await configureHardwarePage(page);
		await page.goto('/');
		console.log('Waiting for 058B:0015...');
		const stopTimeout = infineonStopTimeoutEnabled();
		const result = await page.evaluate(value => window.browserUSBTest.runInfineonBoot(value), stopTimeout);
		console.log(result);
		if (stopTimeout)
			expect(result.stopTimeout?.split(' ')).toHaveLength(2);
		expect(errors).toEqual([]);
	});
});
