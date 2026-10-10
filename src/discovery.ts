import createDebug from 'debug';
import {
	getUSBSerialInterfaceNumbers,
	isSupportedUSBDevice,
} from './drivers/registry.js';
import type { WebUSBPortInfo } from './types.js';
import { createPortPath, formatUSBId } from './utils.js';

const debug = createDebug('serialport:webusb:binding');

interface USBDeviceMetadata {
	manufacturer: string | undefined;
	serialNumber: string | undefined;
}

function readUSBString(
	device: USBDevice,
	property: 'manufacturerName' | 'serialNumber',
): string | undefined {
	try {
		return device[property] ?? undefined;
	} catch (error) {
		if (debug.enabled) {
			debug(
				'cannot read USB %s for %s:%s: %O',
				property,
				formatUSBId(device.vendorId),
				formatUSBId(device.productId),
				error,
			);
		}
		return undefined;
	}
}

function readUSBDeviceMetadata(device: USBDevice): USBDeviceMetadata {
	return {
		manufacturer: readUSBString(device, 'manufacturerName'),
		serialNumber: readUSBString(device, 'serialNumber'),
	};
}

export function getPortInfo(
	device: USBDevice,
	interfaceNumber: number,
	includeInterfaceInPath: boolean,
	duplicate: number,
	metadata = readUSBDeviceMetadata(device),
): WebUSBPortInfo {
	const path = new URL(createPortPath({
		vendorId: device.vendorId,
		productId: device.productId,
		serialNumber: metadata.serialNumber,
		interfaceNumber: includeInterfaceInPath ? interfaceNumber : undefined,
	}));
	if (duplicate > 0)
		path.searchParams.set('instance', duplicate.toString());

	return {
		path: path.toString(),
		manufacturer: metadata.manufacturer,
		serialNumber: metadata.serialNumber,
		pnpId: `USB\\VID_${formatUSBId(device.vendorId)}&PID_${formatUSBId(device.productId)}`,
		locationId: undefined,
		productId: formatUSBId(device.productId),
		vendorId: formatUSBId(device.vendorId),
		nativeDevice: device,
		interfaceNumber,
	};
}

export async function listUSBPorts(provider: USB): Promise<WebUSBPortInfo[]> {
	const counters = new Map<string, number>();
	const ports: WebUSBPortInfo[] = [];
	for (const device of await provider.getDevices()) {
		if (!isSupportedUSBDevice(device))
			continue;
		const metadata = readUSBDeviceMetadata(device);
		const interfaceNumbers = getUSBSerialInterfaceNumbers(device);
		const includeInterfaceInPath = interfaceNumbers.length > 1;
		for (const interfaceNumber of interfaceNumbers) {
			const basePath = createPortPath({
				vendorId: device.vendorId,
				productId: device.productId,
				serialNumber: metadata.serialNumber,
				interfaceNumber: includeInterfaceInPath ? interfaceNumber : undefined,
			});
			const duplicate = counters.get(basePath) ?? 0;
			counters.set(basePath, duplicate + 1);
			ports.push(getPortInfo(device, interfaceNumber, includeInterfaceInPath, duplicate, metadata));
		}
	}
	return ports;
}
