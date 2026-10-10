import type { OpenOptions, PortStatus, SetOptions, UpdateOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };

export interface USBSerialOpenOptions extends Required<OpenOptions> {
	parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

export interface USBSerialDeviceInfo {
	readonly vendorId: number;
	readonly productId: number;
	readonly name: string;
}

export interface USBSerialDriver {
	readonly device: USBDevice;
	open(options: USBSerialOpenOptions): Promise<void>;
	close(): Promise<void>;
	read(buffer: Uint8Array, offset: number, length: number): number | Promise<number>;
	write(data: Uint8Array): Promise<void>;
	flush(): Promise<void>;
	update(options: UpdateOptions): Promise<number>;
	set(options: SetOptions): Promise<void>;
	get(): Promise<PortStatus>;
}
