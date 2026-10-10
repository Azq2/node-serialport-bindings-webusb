import { expect, it } from 'vitest';
import { readBFC } from '../PhoneTests.js';
import {
	hardwareTestsEnabled,
	listSelectedHardwarePorts,
	openHardwarePort,
} from './helpers.js';

const enabled = hardwareTestsEnabled();
const ports = enabled ? await listSelectedHardwarePorts() : [];

it('finds a supported USB serial device for BFC', {
	skip: !enabled || ports.length > 0,
}, () => {
	throw new Error('No supported USB serial devices were found');
});

for (const portInfo of ports) {
	it(`reads 1 MiB of flash through BFC on ${portInfo.path}`, {
		timeout: 180_000,
	}, async () => {
		const port = await openHardwarePort(portInfo);
		try {
			const result = await readBFC(port);
			expect(result.bytesRead).toBe(1024 * 1024);
			expect(result.distinctBytes).toBeGreaterThan(1);
			console.log(result);
		} finally {
			if (port.isOpen)
				await port.close();
		}
	});
}
