import { expect, it } from 'vitest';
import { loopbackBaudRates, runStressLoopbackSuite } from '../Loopback.js';
import {
	hardwareTestsEnabled,
	listHardwarePorts,
	openHardwareBinding,
} from './helpers.js';

const enabled = hardwareTestsEnabled();
const ports = enabled ? await listHardwarePorts() : [];

it('finds a supported USB serial device', {
	skip: !enabled || ports.length > 0,
}, () => {
	throw new Error('No supported USB serial devices were found');
});

for (const port of ports) {
	for (const baudRate of loopbackBaudRates(port.nativeDevice)) {
		it(`runs loopback and stress loopback on ${port.path} at ${baudRate} baud`, {
			timeout: 60_000,
		}, async () => {
			const binding = await openHardwareBinding(port, baudRate);
			try {
				expect(await binding.getBaudRate()).toEqual({ baudRate });
				const result = await runStressLoopbackSuite(binding);
				expect(result.small.bytes).toBeGreaterThan(0);
				expect(result.large.bytes).toBeGreaterThan(0);
				console.log(port.path, baudRate, result);
			} finally {
				await binding.close();
			}
		});
	}
}
