import { expect, test } from '@playwright/test';

for (const kind of ['pl2303', 'ch341', 'cp210x', 'ftdi', 'cdc-acm']) {
	test(`runs ${kind} loopback in a WebUSB worker`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto(`/?emulator=${kind}`);
		await page.getByRole('button', { name: 'Select USB device' }).click();
		await expect(page.locator('#status')).toHaveText('selected');
		await page.evaluate(() => window.browserUSBTest.runLoopback());
		expect(errors).toEqual([]);
	});
}
