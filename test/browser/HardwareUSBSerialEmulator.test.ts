import { expect, test } from '@playwright/test';
import { getDeviceList, type Device } from 'usb';
import { hardwareTestsEnabled } from '../HardwareConfig.js';
import {
	findUSBSerialEmulatorDevice,
	USB_SERIAL_EMULATOR_PROFILES,
	USB_SERIAL_EMULATOR_SERIAL_NUMBER,
} from '../USBSerialEmulator.js';
import { HardwareWebUSB } from '../hardware/HardwareWebUSB.js';
import {
	attachKernelDrivers,
	detachKernelDrivers,
	findUSBDeviceAt,
} from '../hardware/KernelDriver.js';
import {
	configureHardwarePage,
	openHardwarePage,
	withHardwareBrowser,
} from './BrowserHardware.js';

test('runs loopback through every usb-serial-emu profile', async () => {
	test.skip(!hardwareTestsEnabled(), 'Browser hardware tests are disabled');
	test.setTimeout(10 * 60_000);
	const provider = new HardwareWebUSB();
	let device = findUSBSerialEmulatorDevice(await provider.getDevices());
	const location = provider.locationOf(device);
	const busNumber = location.busNumber;
	const portNumbers = location.portNumbers;
	const nativeDevice = findUSBDeviceAt(busNumber, portNumbers);
	if (!nativeDevice)
		throw new Error('usb-serial-emu is not available through node-usb');
	let attachedDevice: Device = nativeDevice;
	let detached = detachKernelDrivers(attachedDevice);
	await withHardwareBrowser(USB_SERIAL_EMULATOR_PROFILES, async page => {
		const errors = await configureHardwarePage(page);
		try {
			for (const profile of USB_SERIAL_EMULATOR_PROFILES) {
				device = await provider.selectProfile(device, profile, busNumber, portNumbers);
				const nextDevice = findUSBDeviceAt(busNumber, portNumbers);
				if (!nextDevice)
					throw new Error(`usb-serial-emu did not attach as ${profile.name}`);
				attachedDevice = nextDevice;
				detached = detachKernelDrivers(attachedDevice);
				await openHardwarePage(page, {
					...profile,
					serialNumber: USB_SERIAL_EMULATOR_SERIAL_NUMBER,
				});
				const result = await page.evaluate(() => window.browserUSBTest.runStressLoopback());
				expect(result.small.bytes, `${profile.name} small writes`).toBeGreaterThan(0);
				expect(result.large.bytes, `${profile.name} large writes`).toBeGreaterThan(0);
				console.log(profile.name, result);
			}
			expect(errors).toEqual([]);
		} finally {
			if (getDeviceList().includes(attachedDevice))
				attachKernelDrivers(attachedDevice, detached);
		}
	});
});
