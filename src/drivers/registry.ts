import type { USBSerialDeviceInfo, USBSerialDriver } from './types.js';
import { CDCACMDriver } from './CDCACM/CDCACMDriver.js';
import { CH341Driver } from './CH341/CH341Driver.js';
import { CP210xDriver } from './CP210x/CP210xDriver.js';
import { FTDIDriver } from './FTDI/FTDIDriver.js';
import { PL2303Driver } from './PL2303/PL2303Driver.js';

export type USBSerialDriverType = 'pl2303' | 'ch341' | 'ftdi' | 'cp210x' | 'cdc-acm';

interface USBSerialDriverDefinition {
	readonly type: USBSerialDriverType;
	readonly devices: readonly USBSerialDeviceInfo[];
	readonly filters: readonly USBDeviceFilter[];
	matches(device: USBDevice): boolean;
	getInterfaceNumbers(device: USBDevice): readonly number[];
	create(device: USBDevice, interfaceNumber?: number): USBSerialDriver;
}

function matchesDevice(info: USBSerialDeviceInfo, vendorId: number, productId: number): boolean {
	return info.vendorId === vendorId && info.productId === productId;
}

function createDefinition(
	type: USBSerialDriverType,
	devices: readonly USBSerialDeviceInfo[],
	getInterfaceNumbers: (device: USBDevice) => readonly number[],
	create: (device: USBDevice, interfaceNumber?: number) => USBSerialDriver,
	options: {
		filters?: readonly USBDeviceFilter[];
		matches?: (device: USBDevice) => boolean;
	} = {},
): USBSerialDriverDefinition {
	return {
		type,
		devices,
		filters: options.filters ?? devices.map(device => ({ vendorId: device.vendorId, productId: device.productId })),
		matches: options.matches ?? (device => devices.some(info => matchesDevice(info, device.vendorId, device.productId))),
		getInterfaceNumbers,
		create,
	};
}

const DRIVER_DEFINITIONS: readonly USBSerialDriverDefinition[] = [
	createDefinition('pl2303', PL2303Driver.supportedDevices, PL2303Driver.getInterfaceNumbers,
		(device, interfaceNumber) => new PL2303Driver(device, interfaceNumber)),
	createDefinition('ch341', CH341Driver.supportedDevices, CH341Driver.getInterfaceNumbers,
		(device, interfaceNumber) => new CH341Driver(device, interfaceNumber)),
	createDefinition('ftdi', FTDIDriver.supportedDevices, FTDIDriver.getInterfaceNumbers,
		(device, interfaceNumber) => new FTDIDriver(device, interfaceNumber)),
	createDefinition('cp210x', CP210xDriver.supportedDevices, CP210xDriver.getInterfaceNumbers,
		(device, interfaceNumber) => new CP210xDriver(device, interfaceNumber)),
	createDefinition('cdc-acm', CDCACMDriver.supportedDevices, CDCACMDriver.getInterfaceNumbers,
		(device, interfaceNumber) => new CDCACMDriver(device, interfaceNumber), {
			filters: CDCACMDriver.usbFilters,
			matches: CDCACMDriver.matches,
		}),
];

function uniqueFilters(filters: readonly USBDeviceFilter[]): USBDeviceFilter[] {
	const keys = new Set<string>();
	return filters.filter(filter => {
		const key = [
			filter.vendorId,
			filter.productId,
			filter.classCode,
			filter.subclassCode,
			filter.protocolCode,
			filter.serialNumber,
		].join(':');
		if (keys.has(key))
			return false;
		keys.add(key);
		return true;
	});
}

export const WEBUSB_SERIAL_FILTERS: readonly USBDeviceFilter[] = uniqueFilters(
	DRIVER_DEFINITIONS.flatMap(definition => definition.filters),
);

export function getUSBSerialDriverDefinition(device: USBDevice): USBSerialDriverDefinition | undefined {
	return DRIVER_DEFINITIONS.find(definition =>
		definition.matches(device) && definition.getInterfaceNumbers(device).length > 0,
	);
}

export function getUSBDeviceName(vendorId: number, productId: number): string | undefined {
	for (const definition of DRIVER_DEFINITIONS) {
		const info = definition.devices.find(device => matchesDevice(device, vendorId, productId));
		if (info)
			return info.name;
	}
	return undefined;
}

export function getUSBSerialDriverType(device: USBDevice): USBSerialDriverType | undefined {
	return getUSBSerialDriverDefinition(device)?.type;
}

export function getUSBSerialInterfaceNumbers(device: USBDevice): readonly number[] {
	return getUSBSerialDriverDefinition(device)?.getInterfaceNumbers(device) ?? [];
}

export function isSupportedUSBDevice(device: USBDevice): boolean {
	return getUSBSerialDriverDefinition(device) !== undefined;
}
