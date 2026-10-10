import { expect, it } from 'vitest';
import { createWebUSBBinding } from '../src/binding.js';
import { NodeWebUSB } from '../src/NodeWebUSB.js';
import { createPortPath } from '../src/utils.js';
import { USBSerialDevice } from './USBSerialDevice.js';
import { WebUSBEmulator } from './WebUSBEmulator.js';

it('opens a listed device when the path contains only its VID and PID', async () => {
	const device = new USBSerialDevice('ftdi');
	const binding = createWebUSBBinding(() => new WebUSBEmulator([device]));
	const port = await binding.open({
		path: createPortPath({
			vendorId: device.vendorId,
			productId: device.productId,
		}),
		baudRate: 115200,
	});

	expect(device.opened).toBe(true);
	await port.close();
});

it('requires an explicit device in NodeJS', async () => {
	const binding = createWebUSBBinding(() => new NodeWebUSB());

	await expect(binding.open({
		path: 'webusb://any',
		baudRate: 115200,
	})).rejects.toThrow(
		'webusb://any is only available in a browser; pass usbDevice or use a path returned by WebUSBBinding.list()',
	);
});
