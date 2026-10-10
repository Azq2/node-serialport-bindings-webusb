import { expect, it, onTestFinished } from 'vitest';
import { exchangeAT } from '../PhoneTests.js';
import {
	hardwareTestsEnabled,
	listSelectedHardwarePorts,
	openHardwarePort,
} from './helpers.js';

const enabled = hardwareTestsEnabled();
const ports = enabled ? await listSelectedHardwarePorts() : [];

it('finds a supported USB serial device for AT commands', {
	skip: !enabled || ports.length > 0,
}, () => {
	throw new Error('No supported USB serial devices were found');
});

for (const portInfo of ports) {
	it(`exchanges randomized read-only AT commands on ${portInfo.path}`, {
		timeout: 60_000,
	}, async () => {
		const port = await openHardwarePort(portInfo);
		onTestFinished(async () => {
			if (port.isOpen)
				await port.close();
		});
		expect(await exchangeAT(port)).toHaveLength(8);
	});
}
