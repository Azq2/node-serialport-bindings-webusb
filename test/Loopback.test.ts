import { describe, it } from 'vitest';
import { createWebUSBBinding } from '../src/binding.js';
import { runLoopbackSuite } from './Loopback.js';
import { USBSerialDevice, type USBSerialDeviceKind } from './USBSerialDevice.js';
import { WebUSBEmulator } from './WebUSBEmulator.js';

const DRIVERS: readonly USBSerialDeviceKind[] = ['pl2303', 'ch341', 'cp210x', 'ftdi', 'cdc-acm'];

describe.each(DRIVERS)('%s loopback', kind => {
	it('transfers packet-boundary payloads through WebUSB', async () => {
		const device = new USBSerialDevice(kind);
		const webUSB = createWebUSBBinding(() => new WebUSBEmulator([device]));
		const [port] = await webUSB.list();
		if (!port)
			throw new Error(`${kind} was not discovered`);
		const binding = await webUSB.open({
			path: port.path,
			baudRate: 115200,
		});
		try {
			await runLoopbackSuite(binding);
		} finally {
			await binding.close();
		}
	});
});
