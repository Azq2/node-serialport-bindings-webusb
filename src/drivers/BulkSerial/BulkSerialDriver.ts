import createDebug from 'debug';
import type { PortStatus, SetOptions, UpdateOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import { WebUSBError } from '../../WebUSBError.js';
import { transferOutChunks } from '../transferOut.js';
import type { USBSerialDriver, USBSerialOpenOptions } from '../types.js';

const debug = createDebug('serialport/bindings-webusb/bulk');

export interface BulkSerialPort {
	readonly interfaceNumbers: readonly number[];
	readonly controlInterfaceNumber: number;
	readonly inEndpoint: USBEndpoint;
	readonly outEndpoint: USBEndpoint;
	readonly statusEndpoint?: USBEndpoint;
}

interface ReadReceiver {
	buffer: Uint8Array;
	offset: number;
	length: number;
	resolve(count: number): void;
	reject(error: unknown): void;
}

export function activeAlternate(deviceInterface: USBInterface): USBAlternateInterface {
	const alternate = deviceInterface.alternates.find(
		item => item.alternateSetting === deviceInterface.alternate.alternateSetting,
	);
	return alternate ?? deviceInterface.alternate;
}

export function findBulkInterfaceNumbers(device: USBDevice): number[] {
	const configuration = device.configuration ?? device.configurations[0];
	if (!configuration)
		return [];
	return configuration.interfaces
		.filter(deviceInterface => {
			const endpoints = activeAlternate(deviceInterface).endpoints;
			return endpoints.some(endpoint => endpoint.type === 'bulk' && endpoint.direction === 'in') &&
				endpoints.some(endpoint => endpoint.type === 'bulk' && endpoint.direction === 'out');
		})
		.map(deviceInterface => deviceInterface.interfaceNumber);
}

export function webUSBBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return data.buffer instanceof ArrayBuffer ?
		new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
		Uint8Array.from(data);
}

export function selectBulkPort(device: USBDevice, interfaceNumber?: number): BulkSerialPort {
	const configuration = device.configuration;
	if (!configuration)
		throw new WebUSBError('USB device has no active configuration');
	const selectedNumber = interfaceNumber ?? findBulkInterfaceNumbers(device)[0];
	const deviceInterface = configuration.interfaces.find(item => item.interfaceNumber === selectedNumber);
	if (!deviceInterface)
		throw new WebUSBError(`USB interface ${selectedNumber} was not found`);
	const endpoints = activeAlternate(deviceInterface).endpoints;
	const inEndpoint = endpoints.find(endpoint => endpoint.type === 'bulk' && endpoint.direction === 'in');
	const outEndpoint = endpoints.find(endpoint => endpoint.type === 'bulk' && endpoint.direction === 'out');
	if (!inEndpoint || !outEndpoint)
		throw new WebUSBError(`USB interface ${selectedNumber} has no bulk serial endpoints`);
	return {
		interfaceNumbers: [selectedNumber],
		controlInterfaceNumber: selectedNumber,
		inEndpoint,
		outEndpoint,
		statusEndpoint: endpoints.find(endpoint => endpoint.type === 'interrupt' && endpoint.direction === 'in'),
	};
}

function dataViewBytes(data: DataView): Uint8Array {
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export abstract class BulkSerialDriver implements USBSerialDriver {
	readonly device: USBDevice;
	protected readonly requestedInterfaceNumber?: number;
	protected port?: BulkSerialPort;
	protected options?: USBSerialOpenOptions;
	protected opened = false;
	private closing?: Promise<void>;
	private readonly claimedInterfaceNumbers: number[] = [];
	private readonly readResults: Uint8Array[] = [];
	private readResultIndex = 0;
	private readResultOffset = 0;
	private readReceiver?: ReadReceiver;
	private readFailure?: unknown;
	private statusFailure?: unknown;

	constructor(device: USBDevice, interfaceNumber?: number) {
		this.device = device;
		this.requestedInterfaceNumber = interfaceNumber;
	}

	protected get bulkReadCount(): number {
		return 2;
	}

	protected get bulkReadLength(): number {
		return this.port?.inEndpoint.packetSize ?? 64;
	}

	protected get bulkWriteLength(): number {
		return this.port?.outEndpoint.packetSize ?? 64;
	}

	protected abstract selectPort(): BulkSerialPort;
	protected abstract initialize(options: USBSerialOpenOptions): Promise<number>;
	protected abstract configure(options: USBSerialOpenOptions): Promise<number>;
	protected abstract setSignals(options: SetOptions): Promise<void>;
	protected abstract readStatus(): Promise<PortStatus>;

	protected async shutdown(): Promise<void> {}

	protected processInput(data: Uint8Array): readonly Uint8Array[] {
		return [data];
	}

	protected processStatus(_data: Uint8Array): void {}

	protected async recoverBulkIn(_result: USBInTransferResult): Promise<boolean> {
		return false;
	}

	protected encodeOutput(data: Uint8Array): readonly Uint8Array[] {
		return [data];
	}

	async open(options: USBSerialOpenOptions): Promise<void> {
		if (this.closing)
			await this.closing;
		if (this.opened)
			return;
		this.options = options;
		this.readFailure = undefined;
		this.statusFailure = undefined;
		try {
			await this.device.open();
			if (!this.device.configuration) {
				const configuration = this.device.configurations[0];
				if (!configuration)
					throw new WebUSBError('USB device has no configuration');
				await this.device.selectConfiguration(configuration.configurationValue);
			}
			this.port = this.selectPort();
			for (const interfaceNumber of this.port.interfaceNumbers) {
				await this.device.claimInterface(interfaceNumber);
				this.claimedInterfaceNumbers.push(interfaceNumber);
			}
			options.baudRate = await this.initialize(options);
			this.opened = true;
			for (let index = 0; index < this.bulkReadCount; index++)
				void this.runBulkRead();
			if (this.port.statusEndpoint)
				void this.runStatusRead();
		} catch (error) {
			try {
				await this.cleanup();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'USB serial open and cleanup failed');
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closing)
			return this.closing;
		if (!this.opened)
			return;
		this.closing = this.closeTransfer().finally(() => { this.closing = undefined; });
		return this.closing;
	}

	private async closeTransfer(): Promise<void> {
		this.opened = false;
		this.rejectRead(new DOMException('The USB serial device was closed', 'AbortError'));
		let firstError: unknown;
		if (this.options?.hupcl) {
			try {
				await this.setSignals({ dtr: false, rts: false });
			} catch (error) {
				firstError = error;
			}
		}
		try {
			await this.shutdown();
		} catch (error) {
			firstError ??= error;
		}
		try {
			await this.cleanup();
		} catch (error) {
			firstError ??= error;
		}
		if (firstError)
			throw firstError;
	}

	private async cleanup(): Promise<void> {
		this.opened = false;
		let firstError: unknown;
		for (const interfaceNumber of this.claimedInterfaceNumbers.reverse()) {
			try {
				await this.device.releaseInterface(interfaceNumber);
			} catch (error) {
				firstError ??= error;
			}
		}
		this.claimedInterfaceNumbers.length = 0;
		try {
			if (this.device.opened)
				await this.device.close();
		} catch (error) {
			firstError ??= error;
		}
		this.port = undefined;
		this.readResults.length = 0;
		this.readResultIndex = 0;
		this.readResultOffset = 0;
		if (firstError)
			throw firstError;
	}

	read(buffer: Uint8Array, offset: number, length: number): number | Promise<number> {
		const count = this.consumeReadResults(buffer, offset, length);
		if (count > 0)
			return count;
		if (this.readFailure)
			return Promise.reject(this.readFailure);
		return new Promise((resolve, reject) => {
			this.readReceiver = { buffer, offset, length, resolve, reject };
		});
	}

	async write(data: Uint8Array): Promise<void> {
		const endpoint = this.requirePort().outEndpoint.endpointNumber;
		await transferOutChunks(this.device, endpoint, this.outputChunks(data), 'USB');
	}

	private *outputChunks(data: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
		for (let offset = 0; offset < data.byteLength; offset += this.bulkWriteLength) {
			for (const chunk of this.encodeOutput(data.subarray(offset, offset + this.bulkWriteLength)))
				yield webUSBBytes(chunk);
		}
	}

	async flush(): Promise<void> {
		this.readResults.length = 0;
		this.readResultIndex = 0;
		this.readResultOffset = 0;
	}

	async update(options: UpdateOptions): Promise<number> {
		const current = this.requireOptions();
		const next = { ...current, baudRate: options.baudRate };
		const baudRate = await this.configure(next);
		this.options = { ...next, baudRate };
		return baudRate;
	}

	async set(options: SetOptions): Promise<void> {
		await this.setSignals(options);
	}

	async get(): Promise<PortStatus> {
		if (this.statusFailure)
			throw this.statusFailure;
		return this.readStatus();
	}

	protected requirePort(): BulkSerialPort {
		if (!this.port)
			throw new WebUSBError('USB serial endpoints are not initialized');
		return this.port;
	}

	protected requireOptions(): USBSerialOpenOptions {
		if (!this.options)
			throw new WebUSBError('USB serial options are not initialized');
		return this.options;
	}

	private async runBulkRead(): Promise<void> {
		const endpoint = this.requirePort().inEndpoint;
		const length = Math.max(this.bulkReadLength, endpoint.packetSize);
		try {
			while (this.opened) {
				const result = await this.device.transferIn(endpoint.endpointNumber, length);
				if (!this.opened)
					return;
				if (result.status !== 'ok') {
					if (await this.recoverBulkIn(result))
						continue;
					this.failRead(new WebUSBError(`USB bulk-in transfer failed with status ${result.status}`, { cause: result }));
					return;
				}
				if (result.data) {
					for (const data of this.processInput(dataViewBytes(result.data))) {
						if (data.byteLength)
							this.finishRead(data);
					}
				}
			}
		} catch (error) {
			if (this.opened)
				this.failRead(error);
		}
	}

	private async runStatusRead(): Promise<void> {
		const endpoint = this.requirePort().statusEndpoint;
		if (!endpoint)
			return;
		while (this.opened) {
			try {
				const result = await this.device.transferIn(endpoint.endpointNumber, endpoint.packetSize);
				if (!this.opened)
					return;
				if (result.status === 'ok' && result.data) {
					this.processStatus(dataViewBytes(result.data));
					this.statusFailure = undefined;
				} else {
					this.statusFailure = new WebUSBError(
						`USB status transfer failed with status ${result.status}`,
						{ cause: result },
					);
					if (debug.enabled)
						debug('status endpoint %d returned %s', endpoint.endpointNumber, result.status);
				}
			} catch (error) {
				if (!this.opened)
					return;
				this.statusFailure = error;
				if (debug.enabled)
					debug('status endpoint failed: %O', error);
			}
		}
	}

	private finishRead(data: Uint8Array): void {
		const receiver = this.readReceiver;
		if (!receiver) {
			this.readResults.push(data);
			return;
		}
		this.readReceiver = undefined;
		const count = Math.min(receiver.length, data.length);
		receiver.buffer.set(data.subarray(0, count), receiver.offset);
		if (count < data.length) {
			this.readResults.push(data);
			this.readResultOffset = count;
		}
		receiver.resolve(count);
	}

	private consumeReadResults(buffer: Uint8Array, offset: number, length: number): number {
		let count = 0;
		while (count < length) {
			const result = this.readResults[this.readResultIndex];
			if (!result)
				break;
			const available = result.length - this.readResultOffset;
			const copied = Math.min(length - count, available);
			buffer.set(result.subarray(this.readResultOffset, this.readResultOffset + copied), offset + count);
			count += copied;
			this.readResultOffset += copied;
			if (this.readResultOffset === result.length) {
				this.readResultIndex++;
				this.readResultOffset = 0;
			}
		}
		if (this.readResultIndex === this.readResults.length) {
			this.readResults.length = 0;
			this.readResultIndex = 0;
		}
		return count;
	}

	private failRead(error: unknown): void {
		this.readFailure ??= error;
		this.rejectRead(this.readFailure);
	}

	private rejectRead(error: unknown): void {
		const receiver = this.readReceiver;
		this.readReceiver = undefined;
		receiver?.reject(error);
	}
}
