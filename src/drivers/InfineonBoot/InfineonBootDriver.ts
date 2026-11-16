import type { PortStatus } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import {
	BulkSerialDriver,
	findBulkInterfaceNumbers,
	selectBulkPort,
	type BulkSerialPort,
} from '../BulkSerial/BulkSerialDriver.js';
import type { USBSerialDeviceInfo, USBSerialOpenOptions } from '../types.js';

const BOOT_INTERFACE_NUMBER = 0;

export class InfineonBootDriver extends BulkSerialDriver {
	static readonly supportedDevices: readonly USBSerialDeviceInfo[] = [
		{ vendorId: 0x058B, productId: 0x0015, name: 'Infineon USB boot' },
	];

	static getInterfaceNumbers(device: USBDevice): readonly number[] {
		return findBulkInterfaceNumbers(device).includes(BOOT_INTERFACE_NUMBER) ? [BOOT_INTERFACE_NUMBER] : [];
	}

	protected selectPort(): BulkSerialPort {
		return selectBulkPort(this.device, BOOT_INTERFACE_NUMBER);
	}

	protected async initialize(options: USBSerialOpenOptions): Promise<number> {
		return options.baudRate;
	}

	protected async configure(options: USBSerialOpenOptions): Promise<number> {
		return options.baudRate;
	}

	protected async setSignals(): Promise<void> {}

	protected async readStatus(): Promise<PortStatus> {
		return { cts: true, dsr: true, dcd: false };
	}
}
