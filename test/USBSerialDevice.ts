const REQUEST_SET_LINE = 0x20;
const REQUEST_GET_LINE = 0x21;
const REQUEST_SET_CONTROL = 0x22;
const REQUEST_BREAK = 0x23;
const REQUEST_VENDOR = 0x01;
const REQUEST_VENDOR_N = 0x80;
const REQUEST_VENDOR_READ_N = 0x81;
const REQUEST_RESET_MP = 0x96;
const REQUEST_GET_DESCRIPTOR = 0x06;

const STATUS_ENDPOINT = 1;
const OUT_ENDPOINT = 2;
const IN_ENDPOINT = 3;

const CP210X_OUT_LENGTHS = new Map([
	[0x00, 0], [0x03, 0], [0x05, 0], [0x07, 0], [0x12, 0],
	[0x13, 16], [0x19, 6], [0x1E, 4],
]);

interface PendingTransfer {
	endpointNumber: number;
	length: number;
	resolve(result: USBInTransferResult): void;
	reject(error: unknown): void;
}

export type USBSerialDeviceKind = 'pl2303' | 'ch341' | 'cp210x' | 'ftdi' | 'cdc-acm';

const DEFAULT_DEVICE_IDS: Readonly<Record<USBSerialDeviceKind, readonly [number, number]>> = {
	'pl2303': [0x067B, 0x2303],
	'ch341': [0x1A86, 0x7523],
	'cp210x': [0x10C4, 0xEA60],
	'ftdi': [0x0403, 0x6001],
	'cdc-acm': [0x04DA, 0x2129],
};

function copyBufferSource(data?: BufferSource): Uint8Array {
	if (!data)
		return new Uint8Array(0);
	if (data instanceof ArrayBuffer)
		return new Uint8Array(data.slice(0));
	return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

function transferResult(data: Uint8Array): USBInTransferResult {
	const copy = Uint8Array.from(data);
	return { status: 'ok', data: new DataView(copy.buffer) };
}

interface EmulatedUSBInterface extends USBInterface {
	isClaimed: boolean;
	selectedAlternate: number;
}

interface EmulatedUSBConfiguration extends USBConfiguration {
	readonly interfaces: EmulatedUSBInterface[];
}

function createInterface(
	interfaceNumber: number,
	endpoints: USBEndpoint[],
	interfaceClass = 0xFF,
	interfaceSubclass = 0,
	interfaceProtocol = 0,
): EmulatedUSBInterface {
	const alternate: USBAlternateInterface = {
		alternateSetting: 0,
		interfaceName: null,
		endpoints,
		interfaceClass,
		interfaceSubclass,
		interfaceProtocol,
	};
	return {
		interfaceNumber,
		alternates: [alternate],
		selectedAlternate: 0,
		isClaimed: false,
		get alternate() {
			const selected = this.alternates.find(item => item.alternateSetting === this.selectedAlternate);
			if (!selected)
				throw new Error(`Unknown alternate setting ${this.selectedAlternate}`);
			return selected;
		},
		get claimed() {
			return this.isClaimed;
		},
	};
}

function createPL2303Interfaces(): EmulatedUSBInterface[] {
	return [createInterface(0, [
		{ endpointNumber: STATUS_ENDPOINT, direction: 'in', type: 'interrupt', packetSize: 10 },
		{ endpointNumber: OUT_ENDPOINT, direction: 'out', type: 'bulk', packetSize: 64 },
		{ endpointNumber: IN_ENDPOINT, direction: 'in', type: 'bulk', packetSize: 64 },
	])];
}

function createUSBSerialInterfaces(kind: USBSerialDeviceKind): EmulatedUSBInterface[] {
	if (kind === 'cdc-acm') {
		return [
			createInterface(0, [
				{ endpointNumber: 2, direction: 'in', type: 'interrupt', packetSize: 16 },
			], 0x02, 0x02, 1),
			createInterface(1, [
				{ endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
				{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
			], 0x0A),
		];
	}
	const endpoints: USBEndpoint[] = [
		{ endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
		{ endpointNumber: 3, direction: 'in', type: 'bulk', packetSize: 64 },
	];
	if (kind === 'ch341')
		endpoints.unshift({ endpointNumber: 1, direction: 'in', type: 'interrupt', packetSize: 4 });
	return [createInterface(0, endpoints)];
}

function createInterfaces(
	kind: USBSerialDeviceKind,
): EmulatedUSBInterface[] {
	if (kind === 'pl2303')
		return createPL2303Interfaces();
	return createUSBSerialInterfaces(kind);
}

function defaultDeviceVersion(kind: USBSerialDeviceKind): readonly [number, number, number] {
	if (kind === 'ftdi')
		return [6, 0, 0];
	return [3, 0, 0];
}

export class USBSerialDevice implements USBDevice {
	readonly vendorId: number;
	readonly productId: number;
	readonly deviceSubclass = 0;
	readonly deviceProtocol = 0;
	readonly configurations: USBConfiguration[];
	readonly deviceClass = 0;
	readonly usbVersionMajor: number;
	readonly usbVersionMinor: number;
	readonly usbVersionSubminor: number;
	readonly deviceVersionMajor: number;
	readonly deviceVersionMinor: number;
	readonly deviceVersionSubminor: number;
	private lineCoding: Uint8Array = new Uint8Array([0x80, 0x25, 0, 0, 0, 0, 8]);
	private cp210xFlow: Uint8Array = new Uint8Array(16);
	private readonly registers = new Map<number, number>();
	private readonly configurationDescriptor: EmulatedUSBConfiguration;
	private selectedConfiguration?: EmulatedUSBConfiguration;
	private pendingTransfers: PendingTransfer[] = [];
	private input: Uint8Array[] = [];
	private inputIndex = 0;
	private inputOffset = 0;
	private inputLength = 0;
	private inputDeliveryScheduled = false;
	private isOpened = false;

	constructor(readonly kind: USBSerialDeviceKind = 'pl2303') {
		const ids = DEFAULT_DEVICE_IDS[this.kind];
		[this.vendorId, this.productId] = ids;
		const usbVersion = [1, 1, 0];
		const deviceVersion = defaultDeviceVersion(this.kind);
		this.configurationDescriptor = {
			configurationValue: 1,
			configurationName: null,
			interfaces: createInterfaces(this.kind),
		};
		[this.usbVersionMajor, this.usbVersionMinor, this.usbVersionSubminor] = usbVersion;
		[this.deviceVersionMajor, this.deviceVersionMinor, this.deviceVersionSubminor] = deviceVersion;
		this.configurations = [this.configurationDescriptor];
		if (this.kind === 'ch341') {
			this.registers.set(0x05, 1);
			this.registers.set(0x18, 0xC3);
		}
	}

	get manufacturerName(): string | null {
		return 'WebUSB emulator';
	}

	get productName(): string | null {
		return this.kind;
	}

	get serialNumber(): string | null {
		return 'TEST';
	}

	get configuration(): USBConfiguration | null {
		return this.selectedConfiguration ?? null;
	}

	get opened(): boolean {
		return this.isOpened;
	}

	async open(): Promise<void> {
		this.isOpened = true;
	}

	async close(): Promise<void> {
		this.abortPendingTransfers(new DOMException('The device was closed', 'AbortError'));
		for (const deviceInterface of this.configurationDescriptor.interfaces)
			deviceInterface.isClaimed = false;
		this.isOpened = false;
	}

	async forget(): Promise<void> {
		await this.close();
	}

	async selectConfiguration(configurationValue: number): Promise<void> {
		this.requireOpened();
		if (configurationValue !== this.configurationDescriptor.configurationValue)
			throw new DOMException(`Configuration ${configurationValue} was not found`, 'NotFoundError');
		this.abortPendingTransfers(new DOMException('The configuration changed', 'AbortError'));
		for (const deviceInterface of this.configurationDescriptor.interfaces) {
			deviceInterface.isClaimed = false;
			deviceInterface.selectedAlternate = 0;
		}
		this.selectedConfiguration = this.configurationDescriptor;
	}

	async claimInterface(interfaceNumber: number): Promise<void> {
		const deviceInterface = this.getInterface(interfaceNumber);
		if (deviceInterface.isClaimed)
			return;
		deviceInterface.isClaimed = true;
	}

	async releaseInterface(interfaceNumber: number): Promise<void> {
		const deviceInterface = this.getInterface(interfaceNumber);
		if (!deviceInterface.isClaimed)
			return;
		const endpoints = new Set(deviceInterface.alternate.endpoints.map(endpoint => endpoint.endpointNumber));
		this.abortPendingTransfers(
			new DOMException('The interface was released', 'AbortError'),
			transfer => endpoints.has(transfer.endpointNumber),
		);
		deviceInterface.isClaimed = false;
		deviceInterface.selectedAlternate = 0;
	}

	async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
		const deviceInterface = this.getClaimedInterface(interfaceNumber);
		if (!deviceInterface.alternates.some(alternate => alternate.alternateSetting === alternateSetting))
			throw new DOMException(`Alternate setting ${alternateSetting} was not found`, 'NotFoundError');
		this.abortPendingTransfers(new DOMException('The alternate setting changed', 'AbortError'));
		deviceInterface.selectedAlternate = alternateSetting;
	}

	async controlTransferIn(
		setup: USBControlTransferParameters,
		length: number,
	): Promise<USBInTransferResult> {
		this.validateControlTransfer(setup);
		if (setup.requestType === 'standard' && setup.recipient === 'device' &&
			setup.request === REQUEST_GET_DESCRIPTOR && setup.value === 0x0100) {
			const descriptor = new Uint8Array(18);
			descriptor[0] = descriptor.length;
			descriptor[1] = 1;
			descriptor[7] = 64;
			return transferResult(descriptor.subarray(0, length));
		}
		switch (this.kind) {
			case 'pl2303': return this.controlTransferInPL2303(setup, length);
			case 'ch341': return this.controlTransferInCH341(setup, length);
			case 'cp210x': return this.controlTransferInCP210x(setup, length);
			case 'ftdi': return this.controlTransferInFTDI(setup, length);
			case 'cdc-acm': return { status: 'stall' };
		}
	}

	async controlTransferOut(
		setup: USBControlTransferParameters,
		data?: BufferSource,
	): Promise<USBOutTransferResult> {
		this.validateControlTransfer(setup);
		const bytes = copyBufferSource(data);
		switch (this.kind) {
			case 'pl2303': return this.controlTransferOutPL2303(setup, bytes);
			case 'ch341': return this.controlTransferOutCH341(setup, bytes);
			case 'cp210x': return this.controlTransferOutCP210x(setup, bytes);
			case 'ftdi': return this.controlTransferOutFTDI(setup, bytes);
			case 'cdc-acm': return this.controlTransferOutCDCACM(setup, bytes);
		}
	}

	async clearHalt(direction: USBDirection, endpointNumber: number): Promise<void> {
		this.getEndpoint(direction, endpointNumber);
	}

	async transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult> {
		this.getEndpoint('in', endpointNumber);
		return new Promise((resolve, reject) => {
			this.pendingTransfers.push({ endpointNumber, length, resolve, reject });
			this.scheduleInputDelivery();
		});
	}

	async transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult> {
		this.getEndpoint('out', endpointNumber);
		const bytes = copyBufferSource(data);
		if (bytes.length)
			this.queueSerialInput(bytes);
		return { status: 'ok', bytesWritten: bytes.length };
	}

	async isochronousTransferIn(): Promise<USBIsochronousInTransferResult> {
		throw new DOMException('USB serial emulator has no isochronous endpoints', 'NotFoundError');
	}

	async isochronousTransferOut(): Promise<USBIsochronousOutTransferResult> {
		throw new DOMException('USB serial emulator has no isochronous endpoints', 'NotFoundError');
	}

	async reset(): Promise<void> {
		this.requireOpened();
		this.abortPendingTransfers(new DOMException('The device was reset', 'AbortError'));
	}

	private controlTransferInPL2303(
		setup: USBControlTransferParameters,
		length: number,
	): USBInTransferResult {
		if (setup.requestType === 'class' && setup.recipient === 'interface' && setup.request === REQUEST_GET_LINE)
			return transferResult(this.lineCoding.subarray(0, length));
		if (setup.requestType !== 'vendor' || setup.recipient !== 'device' ||
			![REQUEST_VENDOR, REQUEST_VENDOR_N, REQUEST_VENDOR_READ_N].includes(setup.request))
			return { status: 'stall' };
		const register = setup.request === REQUEST_VENDOR && setup.value < 0x100 ? setup.value & ~0x80 : setup.value;
		return transferResult(new Uint8Array([this.registers.get(register) ?? 0]).subarray(0, length));
	}

	private controlTransferInCH341(
		setup: USBControlTransferParameters,
		length: number,
	): USBInTransferResult {
		if (setup.requestType !== 'vendor' || setup.recipient !== 'device')
			return { status: 'stall' };
		if (setup.request === 0x5F && length === 2)
			return transferResult(new Uint8Array([0x30, 0]));
		if (setup.request === 0x95 && setup.value === 0x0706 && length === 2)
			return transferResult(new Uint8Array([0xFF, 0]));
		if (setup.request === 0x95 && length === 2) {
			return transferResult(new Uint8Array([
				this.registers.get(setup.value & 0xFF) ?? 0,
				this.registers.get(setup.value >> 8) ?? 0,
			]));
		}
		return { status: 'stall' };
	}

	private controlTransferInCP210x(
		setup: USBControlTransferParameters,
		length: number,
	): USBInTransferResult {
		if (setup.requestType === 'vendor' && setup.recipient === 'device' && setup.request === 0xFF) {
			if (setup.value === 0x370B && length === 1)
				return transferResult(new Uint8Array([2]));
			if (setup.value === 0x0010 && length === 3)
				return transferResult(new Uint8Array([2, 0, 0]));
		}
		if (setup.requestType !== 'vendor' || setup.recipient !== 'interface')
			return { status: 'stall' };
		if (setup.request === 0x14 && length === 16)
			return transferResult(this.cp210xFlow);
		if (setup.request === 0x08 && length === 1)
			return transferResult(new Uint8Array([0]));
		return { status: 'stall' };
	}

	private controlTransferInFTDI(
		setup: USBControlTransferParameters,
		length: number,
	): USBInTransferResult {
		if (setup.requestType !== 'vendor' || setup.recipient !== 'device')
			return { status: 'stall' };
		if (setup.request === 0x0A && length === 1)
			return transferResult(new Uint8Array([16]));
		if (setup.request === 5 && length === 2)
			return transferResult(new Uint8Array([0, 0x60]));
		return { status: 'stall' };
	}

	private controlTransferOutPL2303(
		setup: USBControlTransferParameters,
		bytes: Uint8Array,
	): USBOutTransferResult {
		if (setup.requestType === 'class' && setup.recipient === 'interface') {
			if (setup.request === REQUEST_SET_LINE && bytes.length === 7)
				this.lineCoding = bytes;
			else if ((setup.request !== REQUEST_SET_CONTROL && setup.request !== REQUEST_BREAK) || bytes.length !== 0)
				return { status: 'stall', bytesWritten: 0 };
		} else if (setup.requestType === 'vendor' && setup.recipient === 'device' &&
			setup.request === REQUEST_RESET_MP && bytes.length === 0) {
			return { status: 'ok', bytesWritten: 0 };
		} else if (setup.requestType === 'vendor' && setup.recipient === 'device' && bytes.length === 0 &&
			(setup.request === REQUEST_VENDOR || setup.request === REQUEST_VENDOR_N)) {
			this.registers.set(setup.value, setup.index);
		} else {
			return { status: 'stall', bytesWritten: 0 };
		}
		return { status: 'ok', bytesWritten: bytes.length };
	}

	private controlTransferOutCH341(
		setup: USBControlTransferParameters,
		bytes: Uint8Array,
	): USBOutTransferResult {
		if (setup.requestType !== 'vendor' || setup.recipient !== 'device' || bytes.length !== 0 ||
			![0x9A, 0xA1, 0xA4].includes(setup.request))
			return { status: 'stall', bytesWritten: 0 };
		if (setup.request === 0x9A) {
			this.registers.set(setup.value & 0xFF, setup.index & 0xFF);
			this.registers.set(setup.value >> 8, setup.index >> 8);
		}
		return { status: 'ok', bytesWritten: 0 };
	}

	private controlTransferOutCP210x(
		setup: USBControlTransferParameters,
		bytes: Uint8Array,
	): USBOutTransferResult {
		if (setup.requestType !== 'vendor' || setup.recipient !== 'interface' ||
			CP210X_OUT_LENGTHS.get(setup.request) !== bytes.length)
			return { status: 'stall', bytesWritten: 0 };
		if (setup.request === 0x13)
			this.cp210xFlow = bytes;
		return { status: 'ok', bytesWritten: bytes.length };
	}

	private controlTransferOutFTDI(
		setup: USBControlTransferParameters,
		bytes: Uint8Array,
	): USBOutTransferResult {
		if (setup.requestType !== 'vendor' || setup.recipient !== 'device' || bytes.length !== 0 ||
			![0, 1, 2, 3, 4, 9].includes(setup.request))
			return { status: 'stall', bytesWritten: 0 };
		return { status: 'ok', bytesWritten: 0 };
	}

	private controlTransferOutCDCACM(
		setup: USBControlTransferParameters,
		bytes: Uint8Array,
	): USBOutTransferResult {
		if (setup.requestType !== 'class' || setup.recipient !== 'interface')
			return { status: 'stall', bytesWritten: 0 };
		if (setup.request === REQUEST_SET_LINE && bytes.length === 7)
			this.lineCoding = bytes;
		else if ((setup.request !== REQUEST_SET_CONTROL && setup.request !== REQUEST_BREAK) || bytes.length !== 0)
			return { status: 'stall', bytesWritten: 0 };
		return { status: 'ok', bytesWritten: bytes.length };
	}

	private queueInput(data: Uint8Array): void {
		this.input.push(data);
		this.inputLength += data.length;
		this.scheduleInputDelivery();
	}

	private queueSerialInput(data: Uint8Array): void {
		if (this.kind !== 'ftdi') {
			this.queueInput(data);
			return;
		}
		const packetSize = 64;
		const payloadSize = packetSize - 2;
		const packetCount = Math.ceil(data.length / payloadSize);
		const transfer = new Uint8Array(data.length + packetCount * 2);
		let inputOffset = 0;
		let transferOffset = 0;
		while (inputOffset < data.length) {
			const length = Math.min(payloadSize, data.length - inputOffset);
			transfer[transferOffset] = 0;
			transfer[transferOffset + 1] = 0x60;
			transfer.set(data.subarray(inputOffset, inputOffset + length), transferOffset + 2);
			inputOffset += length;
			transferOffset += length + 2;
		}
		this.queueInput(transfer);
	}

	private takeInput(endpointNumber: number, length: number): Uint8Array | undefined {
		if (this.getEndpoint('in', endpointNumber).type === 'interrupt')
			return undefined;
		if (this.inputLength === 0)
			return undefined;
		const data = new Uint8Array(Math.min(length, this.inputLength));
		let offset = 0;
		while (offset < data.length) {
			const chunk = this.input[this.inputIndex];
			const count = Math.min(data.length - offset, chunk.length - this.inputOffset);
			data.set(chunk.subarray(this.inputOffset, this.inputOffset + count), offset);
			offset += count;
			this.inputOffset += count;
			if (this.inputOffset === chunk.length) {
				this.inputIndex++;
				this.inputOffset = 0;
			}
		}
		this.inputLength -= data.length;
		if (this.inputLength === 0) {
			this.input = [];
			this.inputIndex = 0;
		}
		return data;
	}

	private scheduleInputDelivery(): void {
		if (this.inputDeliveryScheduled)
			return;
		this.inputDeliveryScheduled = true;
		queueMicrotask(() => this.resolvePendingTransfer());
	}

	private resolvePendingTransfer(): void {
		this.inputDeliveryScheduled = false;
		for (let index = 0; index < this.pendingTransfers.length;) {
			const transfer = this.pendingTransfers[index];
			const data = this.takeInput(transfer.endpointNumber, transfer.length);
			if (!data) {
				index++;
				continue;
			}
			this.pendingTransfers.splice(index, 1);
			transfer.resolve(transferResult(data));
			if (this.inputLength > 0)
				this.scheduleInputDelivery();
			return;
		}
	}

	private abortPendingTransfers(error: Error, matches: (transfer: PendingTransfer) => boolean = () => true): void {
		const pending: PendingTransfer[] = [];
		for (const transfer of this.pendingTransfers) {
			if (matches(transfer))
				transfer.reject(error);
			else
				pending.push(transfer);
		}
		this.pendingTransfers = pending;
	}

	private validateControlTransfer(setup: USBControlTransferParameters): void {
		this.requireConfigured();
		if (setup.recipient === 'interface')
			this.getClaimedInterface(setup.index);
	}

	private getEndpoint(direction: USBDirection, endpointNumber: number): USBEndpoint {
		const configuration = this.requireConfigured();
		for (const deviceInterface of configuration.interfaces) {
			if (!deviceInterface.isClaimed)
				continue;
			const endpoint = deviceInterface.alternate.endpoints.find(
				item => item.direction === direction && item.endpointNumber === endpointNumber,
			);
			if (endpoint)
				return endpoint;
		}
		throw new DOMException(`Endpoint ${endpointNumber} was not found`, 'NotFoundError');
	}

	private getInterface(interfaceNumber: number): EmulatedUSBInterface {
		const configuration = this.requireConfigured();
		const deviceInterface = configuration.interfaces.find(item => item.interfaceNumber === interfaceNumber);
		if (!deviceInterface)
			throw new DOMException(`Interface ${interfaceNumber} was not found`, 'NotFoundError');
		return deviceInterface;
	}

	private getClaimedInterface(interfaceNumber: number): EmulatedUSBInterface {
		const deviceInterface = this.getInterface(interfaceNumber);
		if (!deviceInterface.isClaimed)
			throw new DOMException(`Interface ${interfaceNumber} is not claimed`, 'InvalidStateError');
		return deviceInterface;
	}

	private requireConfigured(): EmulatedUSBConfiguration {
		this.requireOpened();
		if (!this.selectedConfiguration)
			throw new DOMException('The device is not configured', 'InvalidStateError');
		return this.selectedConfiguration;
	}

	private requireOpened(): void {
		if (!this.isOpened)
			throw new DOMException('The device is not open', 'InvalidStateError');
	}
}
