import { SerialPortStream } from '@serialport/stream';
import { AsyncSerialPort } from '@sie-js/serial';
import { createWebUSBBinding } from '../../src/binding.js';
import type {
	WebUSBBindingInterface,
	WebUSBPortBinding,
	WebUSBPortInfo,
} from '../../src/types.js';
import { readHardwareSelector } from '../HardwareConfig.js';
import { HardwareWebUSB } from './HardwareWebUSB.js';

export { hardwareTestsEnabled } from '../HardwareConfig.js';

const provider = new HardwareWebUSB();
const binding = createWebUSBBinding(() => provider);

export async function listHardwarePorts(): Promise<WebUSBPortInfo[]> {
	const ports = await binding.list();
	const selector = readHardwareSelector();
	if (!selector)
		return ports;
	return ports.filter(port => {
		const device = port.nativeDevice;
		if (device.vendorId !== selector.vendorId || device.productId !== selector.productId)
			return false;
		if (selector.serialNumber !== undefined && device.serialNumber !== selector.serialNumber)
			return false;
		return selector.busNumber === undefined ||
			provider.locationOf(device).busNumber === selector.busNumber;
	});
}

export async function listSelectedHardwarePorts(): Promise<WebUSBPortInfo[]> {
	if (!readHardwareSelector())
		throw new Error('WEBUSB_DEV is required for this hardware test');
	return listHardwarePorts();
}

export async function openHardwarePort(
	portInfo: WebUSBPortInfo,
): Promise<AsyncSerialPort<WebUSBBindingInterface>> {
	const nativePort = new SerialPortStream<WebUSBBindingInterface>({
		binding,
		path: portInfo.path,
		usbDevice: portInfo.nativeDevice,
		usbInterfaceNumber: portInfo.interfaceNumber,
		baudRate: 115200,
		autoOpen: false,
	});
	const port = new AsyncSerialPort(nativePort);
	await port.open();
	return port;
}

export async function openHardwareBinding(
	port: WebUSBPortInfo,
	baudRate = 115200,
): Promise<WebUSBPortBinding> {
	return binding.open({
		path: port.path,
		usbDevice: port.nativeDevice,
		usbInterfaceNumber: port.interfaceNumber,
		baudRate,
	});
}
