import type {
	OpenOptions,
	PortStatus,
	SetOptions,
	UpdateOptions,
} from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import createDebug from 'debug';
import type { USBSerialDriver } from './drivers/types.js';
import { canceledError, WebUSBError } from './WebUSBError.js';
import type { ResolvedWebUSBOpenOptions, WebUSBPortBinding } from './types.js';

const debug = createDebug('serialport/bindings-webusb');

export class WebUSBPort implements WebUSBPortBinding {
	readonly openOptions: Required<OpenOptions>;
	isOpen = true;
	private readonly driver: USBSerialDriver;
	private lastWrite?: Promise<void>;
	private closing?: Promise<void>;

	constructor(driver: USBSerialDriver, openOptions: ResolvedWebUSBOpenOptions) {
		this.driver = driver;
		this.openOptions = openOptions;
	}

	async close(): Promise<void> {
		if (this.closing)
			return this.closing;
		if (!this.isOpen)
			return;
		if (debug.enabled)
			debug('close %s', this.openOptions.path);
		this.isOpen = false;
		this.closing = this.driver.close().finally(() => {
			this.lastWrite = undefined;
			this.closing = undefined;
		});
		return this.closing;
	}

	async read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer, bytesRead: number }> {
		if (!this.isOpen)
			throw canceledError('Read canceled because the port is closed');

		let bytesRead: number;
		try {
			bytesRead = await this.driver.read(buffer, offset, length);
		} catch (error) {
			if (!this.isOpen)
				throw canceledError('Read canceled because the port was closed', error);
			throw error;
		}
		if (!this.isOpen)
			throw canceledError('Read canceled because the port was closed');

		return { buffer, bytesRead };
	}

	async write(buffer: Buffer): Promise<void> {
		if (!this.isOpen)
			throw canceledError('Write canceled because the port is closed');

		const write = this.driver.write(buffer);
		this.lastWrite = write;
		try {
			await write;
		} catch (error) {
			if (!this.isOpen)
				throw canceledError('Write canceled because the port was closed', error);
			throw error;
		} finally {
			this.lastWrite = undefined;
		}
		if (!this.isOpen)
			throw canceledError('Write canceled because the port was closed');
	}

	async update(options: UpdateOptions): Promise<void> {
		this.assertOpen();
		const baudRate = await this.driver.update(options);
		this.openOptions.baudRate = baudRate;
	}

	async set(options: SetOptions): Promise<void> {
		this.assertOpen();
		await this.driver.set(options);
	}

	async get(): Promise<PortStatus> {
		this.assertOpen();
		return this.driver.get();
	}

	async getBaudRate(): Promise<{ baudRate: number }> {
		return { baudRate: this.openOptions.baudRate };
	}

	async flush(): Promise<void> {
		this.assertOpen();
		await this.driver.flush();
	}

	async drain(): Promise<void> {
		this.assertOpen();
		if (this.lastWrite)
			await this.lastWrite;
	}

	private assertOpen(): void {
		if (!this.isOpen)
			throw new WebUSBError('Port is not open');
	}
}
