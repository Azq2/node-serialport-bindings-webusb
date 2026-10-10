import { WebUSBBinding, type WebUSBPortBinding } from '../src/index.js';

export interface USBSerialEmulatorProfile {
	name: string;
	serviceBaudRate: number;
	vendorId: number;
	productId: number;
	usbVersion: number;
	deviceVersion: number;
}

export const USB_SERIAL_EMULATOR_SERIAL_NUMBER = 'USB-SERIAL-EMU';

export const USB_SERIAL_EMULATOR_PROFILES: readonly USBSerialEmulatorProfile[] = [
	{ name: 'ft232r', serviceBaudRate: 600, vendorId: 0x0403, productId: 0x6001, usbVersion: 0x0200, deviceVersion: 0x0600 },
	{ name: 'pl2303-h', serviceBaudRate: 1200, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0110, deviceVersion: 0x0100 },
	{ name: 'pl2303-hx', serviceBaudRate: 1800, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0110, deviceVersion: 0x0300 },
	{ name: 'pl2303-ta', serviceBaudRate: 2400, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0200, deviceVersion: 0x0300 },
	{ name: 'pl2303-tb', serviceBaudRate: 4800, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0200, deviceVersion: 0x0500 },
	{ name: 'pl2303-hxd', serviceBaudRate: 9600, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0110, deviceVersion: 0x0400 },
	{ name: 'pl2303-hxd-clone', serviceBaudRate: 19200, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0110, deviceVersion: 0x0400 },
	{ name: 'pl2303-hxn', serviceBaudRate: 38400, vendorId: 0x067B, productId: 0x2303, usbVersion: 0x0200, deviceVersion: 0x0100 },
	{ name: 'ch340', serviceBaudRate: 7200, vendorId: 0x1A86, productId: 0x7523, usbVersion: 0x0110, deviceVersion: 0x0264 },
	{ name: 'cp2102', serviceBaudRate: 14400, vendorId: 0x10C4, productId: 0xEA60, usbVersion: 0x0200, deviceVersion: 0x0100 },
	{ name: 'cdc-acm', serviceBaudRate: 28800, vendorId: 0x2E8A, productId: 0x000A, usbVersion: 0x0200, deviceVersion: 0x0100 },
	{ name: 'siemens-sx1', serviceBaudRate: 57600, vendorId: 0x11F5, productId: 0x0001, usbVersion: 0x0110, deviceVersion: 0x0300 },
	{ name: 'siemens-x65', serviceBaudRate: 115200, vendorId: 0x11F5, productId: 0x0003, usbVersion: 0x0110, deviceVersion: 0x0300 },
	{ name: 'siemens-x75', serviceBaudRate: 230400, vendorId: 0x11F5, productId: 0x0004, usbVersion: 0x0110, deviceVersion: 0x0300 },
	{ name: 'siemens-ef81', serviceBaudRate: 460800, vendorId: 0x11F5, productId: 0x0005, usbVersion: 0x0110, deviceVersion: 0x0300 },
	{ name: 'benq-siemens-s81', serviceBaudRate: 921600, vendorId: 0x04A5, productId: 0x4027, usbVersion: 0x0110, deviceVersion: 0x0300 },
];

export function findUSBSerialEmulatorDevice(devices: readonly USBDevice[]): USBDevice {
	const candidates = devices.filter(device => device.serialNumber === USB_SERIAL_EMULATOR_SERIAL_NUMBER);
	if (candidates.length === 1)
		return candidates[0];
	throw new Error(`Expected one connected usb-serial-emu device, found ${candidates.length}`);
}

export async function switchUSBSerialEmulatorProfile(
	currentDevice: USBDevice,
	interfaceNumber: number,
	target: USBSerialEmulatorProfile,
	waitForDevice: () => Promise<USBDevice>,
): Promise<USBDevice> {
	const reenumeration = waitForDevice();
	let binding: WebUSBPortBinding | undefined;
	let commandError: unknown;
	try {
		binding = await WebUSBBinding.open({
			path: 'webusb://usb-serial-emu',
			usbDevice: currentDevice,
			usbInterfaceNumber: interfaceNumber,
			baudRate: target.serviceBaudRate,
			dataBits: 7,
			parity: 'odd',
			stopBits: 2,
			hupcl: false,
		});
		await binding.set({ dtr: false, rts: true, brk: true });
	} catch (error) {
		commandError = error;
	}
	try {
		await binding?.close();
	} catch (error) {
		commandError ??= error;
	}

	try {
		return await reenumeration;
	} catch (error) {
		if (commandError)
			throw new Error(
				`Cannot select USB serial emulator profile ${target.name}: ${String(commandError)}`,
				{ cause: commandError },
			);
		throw error;
	}
}
