export interface USBDeviceIdentity {
	vendorId: number;
	productId: number;
	serialNumber?: string;
	bus?: string;
	address?: number;
	ports?: readonly number[];
	interfaceNumber?: number;
}

export function formatUSBId(value: number): string {
	return value.toString(16).padStart(4, '0').toUpperCase();
}

export function createPortPath(identity: USBDeviceIdentity): string {
	const url = new URL('webusb://device');
	url.searchParams.set('vid', formatUSBId(identity.vendorId));
	url.searchParams.set('pid', formatUSBId(identity.productId));
	if (identity.serialNumber)
		url.searchParams.set('serial', identity.serialNumber);
	if (identity.bus)
		url.searchParams.set('bus', identity.bus);
	if (identity.address !== undefined)
		url.searchParams.set('address', identity.address.toString());
	if (identity.ports?.length)
		url.searchParams.set('ports', identity.ports.join('.'));
	if (identity.interfaceNumber !== undefined)
		url.searchParams.set('interface', identity.interfaceNumber.toString());
	return url.toString();
}

export function matchesPortPath(path: string, selector: string): boolean {
	if (path === selector)
		return true;

	let port: URL;
	let requested: URL;
	try {
		port = new URL(path);
		requested = new URL(selector);
	} catch {
		return false;
	}

	if (
		port.protocol !== requested.protocol ||
		port.host !== requested.host ||
		port.pathname !== requested.pathname ||
		!requested.searchParams.has('vid') ||
		!requested.searchParams.has('pid')
	)
		return false;

	for (const [name, value] of requested.searchParams) {
		const portValue = port.searchParams.get(name);
		if (portValue === null)
			return false;
		if (name === 'vid' || name === 'pid') {
			if (portValue.toLowerCase() !== value.toLowerCase())
				return false;
		} else if (portValue !== value) {
			return false;
		}
	}

	return true;
}

export function dataViewBytes(data: DataView): Uint8Array {
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
