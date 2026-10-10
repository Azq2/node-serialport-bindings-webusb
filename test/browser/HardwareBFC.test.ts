import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { selectedHardwareTest } from './BrowserHardware.js';

selectedHardwareTest('reads flash through BFC on hardware', 240_000, async (page, testInfo) => {
	const result = await page.evaluate(() => window.browserUSBTest.runBFC());
	expect(result.bytesRead).toBe(1024 * 1024);
	expect(result.distinctBytes).toBeGreaterThan(1);
	console.log(result);
	const resultPath = testInfo.outputPath('bfc-result.json');
	await writeFile(resultPath, JSON.stringify(result));
	await testInfo.attach('bfc-result', { path: resultPath, contentType: 'application/json' });
});
