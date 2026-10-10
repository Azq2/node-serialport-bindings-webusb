import { getDeviceList, type Device } from 'usb';

export function findUSBDeviceAt(busNumber: number, portNumbers: readonly number[]): Device | undefined {
	return getDeviceList().find(device =>
		device.busNumber === busNumber && device.portNumbers.join('.') === portNumbers.join('.'),
	);
}

export function detachKernelDrivers(device: Device): number[] {
	device.open();
	const detached: number[] = [];
	try {
		const interfaces = device.interfaces;
		if (!interfaces)
			throw new Error('USB device has no active configuration');
		for (const usbInterface of interfaces) {
			if (usbInterface.isKernelDriverActive()) {
				usbInterface.detachKernelDriver();
				detached.push(usbInterface.interfaceNumber);
			}
		}
		return detached;
	} catch (error) {
		for (const interfaceNumber of [...detached].reverse())
			device.interface(interfaceNumber).attachKernelDriver();
		throw error;
	} finally {
		device.close();
	}
}

export function attachKernelDrivers(device: Device, interfaceNumbers: readonly number[]): void {
	if (interfaceNumbers.length === 0)
		return;
	device.open();
	try {
		for (const interfaceNumber of [...interfaceNumbers].reverse())
			device.interface(interfaceNumber).attachKernelDriver();
	} finally {
		device.close();
	}
}
