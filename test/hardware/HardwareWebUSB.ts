import { usb, type Device } from 'usb';
import { listUSBPorts } from '../../src/discovery.js';
import { NodeWebUSB } from '../../src/NodeWebUSB.js';
import {
	switchUSBSerialEmulatorProfile,
	type USBSerialEmulatorProfile,
	USB_SERIAL_EMULATOR_PROFILES,
} from '../USBSerialEmulator.js';

export function matchesNativeUSBSerialEmulatorProfile(
	device: Device,
	profile: USBSerialEmulatorProfile,
): boolean {
	const descriptor = device.deviceDescriptor;
	return descriptor.idVendor === profile.vendorId &&
		descriptor.idProduct === profile.productId &&
		descriptor.bcdUSB === profile.usbVersion &&
		descriptor.bcdDevice === profile.deviceVersion;
}

export class HardwareWebUSB extends NodeWebUSB {
	locationOf(device: USBDevice): { busNumber: number, portNumbers: readonly number[] } {
		for (const [nativeDevice, webDevice] of this.knownDevices) {
			if (webDevice === device) {
				return { busNumber: nativeDevice.busNumber, portNumbers: nativeDevice.portNumbers };
			}
		}
		throw new Error('USB device has no native location');
	}

	findDeviceAt(busNumber: number, portNumbers: readonly number[]): USBDevice | undefined {
		for (const [nativeDevice, device] of this.knownDevices) {
			if (nativeDevice.busNumber === busNumber &&
				nativeDevice.portNumbers.join('.') === portNumbers.join('.'))
				return device;
		}
		return undefined;
	}

	waitForDeviceAt(
		busNumber: number,
		portNumbers: readonly number[],
		profile: (typeof USB_SERIAL_EMULATOR_PROFILES)[number],
	): Promise<USBDevice> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`usb-serial-emu did not attach as ${profile.name}`));
			}, 8000);
			const onAttach = (nativeDevice: Device) => {
				if (nativeDevice.busNumber !== busNumber ||
					nativeDevice.portNumbers.join('.') !== portNumbers.join('.') ||
					!matchesNativeUSBSerialEmulatorProfile(nativeDevice, profile))
					return;
				queueMicrotask(() => {
					void this.getDevices().then(() => {
						const device = this.findDeviceAt(busNumber, portNumbers);
						if (!device)
							return;
						cleanup();
						resolve(device);
					}, error => {
						cleanup();
						reject(error);
					});
				});
			};
			const cleanup = () => {
				clearTimeout(timeout);
				usb.off('attach', onAttach);
			};
			usb.on('attach', onAttach);
		});
	}

	async selectProfile(
		currentDevice: USBDevice,
		profile: USBSerialEmulatorProfile,
		busNumber: number,
		portNumbers: readonly number[],
	): Promise<USBDevice> {
		const currentPort = (await listUSBPorts(this)).find(port => port.nativeDevice === currentDevice);
		if (!currentPort)
			throw new Error('The current usb-serial-emu profile has no serial interface');
		return switchUSBSerialEmulatorProfile(
			currentDevice,
			currentPort.interfaceNumber,
			profile,
			() => this.waitForDeviceAt(busNumber, portNumbers, profile),
		);
	}
}
