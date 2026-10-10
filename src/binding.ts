import createDebug from 'debug';
import { listUSBPorts } from './discovery.js';
import {
	getUSBSerialDriverDefinition,
	getUSBSerialInterfaceNumbers,
	SUPPORTED_USB_FILTERS,
} from './drivers/registry.js';
import type { USBSerialDriver } from './drivers/types.js';
import { WebUSBError } from './WebUSBError.js';
import { WebUSBPort } from './WebUSBPort.js';
import type {
	ResolvedWebUSBOpenOptions,
	WebUSBBindingInterface,
	WebUSBOpenOptions,
} from './types.js';
import { formatUSBId, matchesPortPath } from './utils.js';

const debug = createDebug('serialport:webusb:binding');

function createDriver(device: USBDevice, interfaceNumber?: number): USBSerialDriver {
	const definition = getUSBSerialDriverDefinition(device);
	if (definition)
		return definition.create(device, interfaceNumber);

	throw new WebUSBError(
		`Unsupported USB device ${formatUSBId(device.vendorId)}:${formatUSBId(device.productId)}`,
	);
}

function resolveOpenOptions(options: WebUSBOpenOptions): ResolvedWebUSBOpenOptions {
	return {
		dataBits: 8,
		lock: true,
		stopBits: 1,
		parity: 'none',
		rtscts: false,
		xon: false,
		xoff: false,
		xany: false,
		hupcl: true,
		...options,
		usbRequestOptions: resolveUSBRequestOptions(options.usbRequestOptions),
	};
}

function resolveUSBRequestOptions(options?: USBDeviceRequestOptions): USBDeviceRequestOptions {
	if (options?.filters.length)
		return options;
	return { ...options, filters: [...SUPPORTED_USB_FILTERS] };
}

async function selectPort(
	provider: USB,
	options: ResolvedWebUSBOpenOptions,
): Promise<{ device: USBDevice, interfaceNumber?: number } | undefined> {
	if (options.path === 'webusb://any') {
		return {
			device: await provider.requestDevice(options.usbRequestOptions),
			interfaceNumber: options.usbInterfaceNumber,
		};
	}

	const ports = await listUSBPorts(provider);
	const port = ports.find(port => matchesPortPath(port.path, options.path));
	if (port)
		return { device: port.nativeDevice, interfaceNumber: port.interfaceNumber };
	return undefined;
}

export function createWebUSBBinding(getProvider: () => USB | Promise<USB>): WebUSBBindingInterface {
	return {
		async open(options) {
			const openOptions = resolveOpenOptions(options);
			const selectedPort = openOptions.usbDevice ? {
				device: openOptions.usbDevice,
				interfaceNumber: openOptions.usbInterfaceNumber,
			} : await selectPort(await getProvider(), openOptions);
			if (!selectedPort)
				throw new WebUSBError(`Invalid port path: ${openOptions.path}`);
			const { device, interfaceNumber } = selectedPort;
			const interfaceNumbers = getUSBSerialInterfaceNumbers(device);
			const selectedInterfaceNumber = interfaceNumber ?? interfaceNumbers[0];
			if (selectedInterfaceNumber === undefined)
				throw new WebUSBError('Selected USB device has no usable serial interface');
			if (!interfaceNumbers.includes(selectedInterfaceNumber))
				throw new WebUSBError(`USB interface ${selectedInterfaceNumber} is not supported by this serial driver`);

			if (debug.enabled) {
				debug(
					'open %s (%s:%s interface %d) at %d baud',
					openOptions.path,
					formatUSBId(device.vendorId),
					formatUSBId(device.productId),
					selectedInterfaceNumber,
					openOptions.baudRate,
				);
			}
			const driver = createDriver(device, selectedInterfaceNumber);
			await driver.open(openOptions);
			return new WebUSBPort(driver, openOptions);
		},

		async list() {
			return listUSBPorts(await getProvider());
		},
	};
}
