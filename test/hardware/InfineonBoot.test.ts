import { expect, it } from 'vitest';
import { createWebUSBBinding } from '../../src/binding.js';
import { INFINEON_BOOT_DEVICE, readBootcoreInfo } from '../InfineonBootTests.js';
import { infineonStopTimeoutEnabled, readHardwareWaitTimeout } from '../HardwareConfig.js';
import { hardwareTestsEnabled } from './helpers.js';
import { HardwareWebUSB } from './HardwareWebUSB.js';

const enabled = hardwareTestsEnabled();
const waitTimeout = enabled ? readHardwareWaitTimeout() : 0;

function waitForBootDevice(provider: HardwareWebUSB): Promise<USBDevice> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			provider.removeEventListener('connect', onConnect);
			reject(new Error('Infineon USB boot device did not connect'));
		}, waitTimeout);
		function onConnect(event: USBConnectionEvent): void {
			const { device } = event;
			if (device.vendorId !== INFINEON_BOOT_DEVICE.vendorId || device.productId !== INFINEON_BOOT_DEVICE.productId)
				return;
			clearTimeout(timer);
			provider.removeEventListener('connect', onConnect);
			provider.getDevices().then(() => resolve(device), reject);
		}
		provider.addEventListener('connect', onConnect);
	});
}

it('reads bootcore and flash information after connect', {
	skip: !enabled,
	timeout: waitTimeout + 30_000,
}, async () => {
	const provider = new HardwareWebUSB();
	console.log('Waiting for 058B:0015...');
	const device = await waitForBootDevice(provider);
	const binding = await createWebUSBBinding(() => provider).open({
		path: 'webusb://infineon-boot',
		usbDevice: device,
		baudRate: 115200,
	});
	try {
		const stopTimeout = infineonStopTimeoutEnabled();
		const result = await readBootcoreInfo(binding, stopTimeout);
		console.log(result);
		if (stopTimeout)
			expect(result.stopTimeout?.split(' ')).toHaveLength(2);
	} finally {
		await binding.close();
	}
});
