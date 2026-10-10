function matchesClass(
	classCode: number,
	subclassCode: number,
	protocolCode: number,
	filter: USBDeviceFilter,
): boolean {
	return classCode === filter.classCode &&
		(filter.subclassCode === undefined || subclassCode === filter.subclassCode) &&
		(filter.protocolCode === undefined || protocolCode === filter.protocolCode);
}

function matchesFilter(device: USBDevice, filter: USBDeviceFilter): boolean {
	const classMatches = filter.classCode === undefined || matchesClass(
		device.deviceClass,
		device.deviceSubclass,
		device.deviceProtocol,
		filter,
	) || device.configurations.some(configuration => configuration.interfaces.some(deviceInterface =>
		deviceInterface.alternates.some(alternate => matchesClass(
			alternate.interfaceClass,
			alternate.interfaceSubclass,
			alternate.interfaceProtocol,
			filter,
		)),
	));
	return (filter.vendorId === undefined || device.vendorId === filter.vendorId) &&
		(filter.productId === undefined || device.productId === filter.productId) &&
		classMatches &&
		(filter.serialNumber === undefined || device.serialNumber === filter.serialNumber);
}

export class WebUSBEmulator extends EventTarget implements USB {
	onconnect: ((this: USB, event: USBConnectionEvent) => unknown) | null = null;
	ondisconnect: ((this: USB, event: USBConnectionEvent) => unknown) | null = null;

	constructor(private readonly devices: USBDevice[]) {
		super();
	}

	addEventListener(
		type: 'connect' | 'disconnect',
		listener: (this: USB, event: USBConnectionEvent) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | ((this: USB, event: USBConnectionEvent) => unknown) | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
	}

	removeEventListener(
		type: 'connect' | 'disconnect',
		listener: (this: USB, event: USBConnectionEvent) => unknown,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | ((this: USB, event: USBConnectionEvent) => unknown) | null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
	}

	async getDevices(): Promise<USBDevice[]> {
		return [...this.devices];
	}

	async requestDevice(options?: USBDeviceRequestOptions): Promise<USBDevice> {
		if (!options?.filters.length)
			throw new TypeError('At least one USB device filter is required');
		const filters = options.filters;
		const exclusionFilters = options.exclusionFilters ?? [];
		const device = this.devices.find(candidate =>
			filters.some(filter => matchesFilter(candidate, filter)) &&
			!exclusionFilters.some(filter => matchesFilter(candidate, filter)),
		);
		if (!device)
			throw new DOMException('No matching USB device was selected', 'NotFoundError');
		return device;
	}
}
