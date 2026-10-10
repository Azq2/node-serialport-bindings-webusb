import { expect, it } from 'vitest';
import { readChaosMemory } from '../PhoneTests.js';
import {
	hardwareTestsEnabled,
	listSelectedHardwarePorts,
	openHardwarePort,
} from './helpers.js';

const enabled = hardwareTestsEnabled();
const ports = enabled ? await listSelectedHardwarePorts() : [];

it('finds a supported USB serial device for Chaos loader', {
	skip: !enabled || ports.length > 0,
}, () => {
	throw new Error('No supported USB serial devices were found');
});

for (const portInfo of ports) {
	it(`reads 1 MiB of flash through Chaos loader on ${portInfo.path}`, {
		timeout: 180_000,
	}, async () => {
		const port = await openHardwarePort(portInfo);
		try {
			const result = await readChaosMemory(port, 0xA0000000, 1024 * 1024, 1625000);
			expect(result).toHaveLength(1024 * 1024);
			expect(new Set(result).size).toBeGreaterThan(1);
		} finally {
			if (port.isOpen)
				await port.close();
		}
	});
}
