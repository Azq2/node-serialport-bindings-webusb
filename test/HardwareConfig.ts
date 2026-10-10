export interface HardwareSelector {
	vendorId: number;
	productId: number;
	busNumber?: number;
	serialNumber?: string;
}

export function hardwareTestsEnabled(): boolean {
	return process.env.WEBUSB_HARDWARE === '1';
}

export function readHardwareSelector(): HardwareSelector | undefined {
	const device = process.env.WEBUSB_DEV;
	if (!device) {
		if (process.env.WEBUSB_BUS !== undefined || process.env.WEBUSB_SERIAL !== undefined)
			throw new Error('WEBUSB_DEV is required with WEBUSB_BUS or WEBUSB_SERIAL');
		return undefined;
	}
	const match = /^([0-9a-f]{4}):([0-9a-f]{4})$/i.exec(device);
	if (!match)
		throw new Error('WEBUSB_DEV must have the VID:PID format');

	const bus = process.env.WEBUSB_BUS;
	if (bus !== undefined && !/^\d+$/.test(bus))
		throw new Error('WEBUSB_BUS must be a decimal USB bus number');

	return {
		vendorId: Number.parseInt(match[1], 16),
		productId: Number.parseInt(match[2], 16),
		busNumber: bus === undefined ? undefined : Number(bus),
		serialNumber: process.env.WEBUSB_SERIAL || undefined,
	};
}
