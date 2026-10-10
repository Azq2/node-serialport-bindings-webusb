import { expect, it } from 'vitest';
import { createWebUSBBinding } from '../../src/binding.js';
import { listUSBPorts } from '../../src/discovery.js';
import { runStressLoopbackSuite } from '../Loopback.js';
import { findUSBSerialEmulatorDevice, USB_SERIAL_EMULATOR_PROFILES } from '../USBSerialEmulator.js';
import { hardwareTestsEnabled } from './helpers.js';
import { HardwareWebUSB } from './HardwareWebUSB.js';

it('runs loopback and stress loopback through every usb-serial-emu profile', {
	skip: !hardwareTestsEnabled(),
	timeout: 10 * 60_000,
}, async () => {
	const provider = new HardwareWebUSB();
	const devices = await provider.getDevices();
	let device = findUSBSerialEmulatorDevice(devices);
	const location = provider.locationOf(device);
	for (const profile of USB_SERIAL_EMULATOR_PROFILES) {
		device = await provider.selectProfile(
			device,
			profile,
			location.busNumber,
			location.portNumbers,
		);
		const serialPort = (await listUSBPorts(provider)).find(candidate => candidate.nativeDevice === device);
		if (!serialPort)
			throw new Error(`${profile.name} has no serial interface`);
		const binding = await createWebUSBBinding(() => provider).open({
			path: serialPort.path,
			usbDevice: device,
			usbInterfaceNumber: serialPort.interfaceNumber,
			baudRate: 115200,
		});
		try {
			const result = await runStressLoopbackSuite(binding);
			expect(result.small.bytes).toBeGreaterThan(0);
			expect(result.large.bytes).toBeGreaterThan(0);
			console.log(profile.name, result);
		} finally {
			await binding.close();
		}
	}
});
