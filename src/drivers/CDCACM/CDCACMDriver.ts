import createDebug from 'debug';
import type { PortStatus, SetOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import { WebUSBError } from '../../WebUSBError.js';
import { activeAlternate, BulkSerialDriver, webUSBBytes, type BulkSerialPort } from '../BulkSerial/BulkSerialDriver.js';
import type { USBSerialDeviceInfo, USBSerialOpenOptions } from '../types.js';
import { CDC_ACM_DEVICE_RULES, type CDCACMDeviceRule, type CDCACMQuirk } from './devices.js';

const debug = createDebug('serialport:webusb:cdc-acm');

const COMMUNICATIONS_CLASS = 0x02;
const ACM_SUBCLASS = 0x02;
const DATA_CLASS = 0x0A;
const ACM_PROTOCOLS = new Set([0, 1, 2, 3, 4, 5, 6]);
const SET_LINE_CODING = 0x20;
const SET_CONTROL_LINE_STATE = 0x22;
const SEND_BREAK = 0x23;
const SERIAL_STATE = 0x20;
const CONTROL_DTR = 1;
const CONTROL_RTS = 2;
const STATE_DCD = 1;
const STATE_DSR = 2;

interface CDCConnection {
	control: USBInterface;
	data: USBInterface;
}

function deviceRule(device: USBDevice): CDCACMDeviceRule | undefined {
	return CDC_ACM_DEVICE_RULES.find(rule =>
		rule.vendorId === device.vendorId && rule.productId === device.productId,
	);
}

function isControlInterface(deviceInterface: USBInterface, rule?: CDCACMDeviceRule): boolean {
	const alternate = activeAlternate(deviceInterface);
	return alternate.interfaceClass === COMMUNICATIONS_CLASS &&
		alternate.interfaceSubclass === ACM_SUBCLASS &&
		(ACM_PROTOCOLS.has(alternate.interfaceProtocol) || Boolean(rule?.vendorProtocol && alternate.interfaceProtocol === 0xFF));
}

function hasDataEndpoints(deviceInterface: USBInterface): boolean {
	const endpoints = activeAlternate(deviceInterface).endpoints;
	return endpoints.some(endpoint => endpoint.direction === 'in' && endpoint.type !== 'isochronous') &&
		endpoints.some(endpoint => endpoint.direction === 'out' && endpoint.type !== 'isochronous');
}

function findConnections(device: USBDevice): CDCConnection[] {
	const configuration = device.configuration ?? device.configurations[0];
	if (!configuration)
		return [];
	const rule = deviceRule(device);
	if (rule?.quirk === 'no-union-01' || rule?.quirk === 'no-union-12') {
		const controlNumber = rule.quirk === 'no-union-01' ? 0 : 1;
		const dataNumber = rule.quirk === 'no-union-01' ? 1 : 2;
		const control = configuration.interfaces.find(item => item.interfaceNumber === controlNumber);
		const data = configuration.interfaces.find(item => item.interfaceNumber === dataNumber);
		return control && data && hasDataEndpoints(data) ? [{ control, data }] : [];
	}
	const controls = configuration.interfaces.filter(deviceInterface => isControlInterface(deviceInterface, rule));
	const dataInterfaces = configuration.interfaces.filter(deviceInterface =>
		(activeAlternate(deviceInterface).interfaceClass === DATA_CLASS || rule?.quirk === 'vendor-data') &&
			hasDataEndpoints(deviceInterface),
	);
	const used = new Set<number>();
	return controls.flatMap(control => {
		if (hasDataEndpoints(control))
			return [{ control, data: control }];
		const data = dataInterfaces.find(candidate =>
			!used.has(candidate.interfaceNumber) && candidate.interfaceNumber > control.interfaceNumber,
		) ?? dataInterfaces.find(candidate => !used.has(candidate.interfaceNumber));
		if (!data)
			return [];
		used.add(data.interfaceNumber);
		return [{ control, data }];
	});
}

function encodeLineCoding(options: USBSerialOpenOptions): Uint8Array {
	const result = new Uint8Array(7);
	const view = new DataView(result.buffer);
	view.setUint32(0, options.baudRate, true);
	result[4] = options.stopBits === 2 ? 2 : 0;
	result[5] = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[options.parity];
	result[6] = options.dataBits;
	return result;
}

export class CDCACMDriver extends BulkSerialDriver {
	static readonly supportedDevices: readonly USBSerialDeviceInfo[] = [
		{ vendorId: 0x04DA, productId: 0x2121, name: 'Panasonic VS/MX/SA' },
		{ vendorId: 0x04DA, productId: 0x2129, name: 'SoftBank 705P' },
		{ vendorId: 0x04DA, productId: 0x213C, name: 'SoftBank 810P' },
		{ vendorId: 0x04DA, productId: 0x2149, name: 'SoftBank 820P' },
		{ vendorId: 0x04DA, productId: 0x2159, name: 'SoftBank 821P' },
		{ vendorId: 0x04DA, productId: 0x2172, name: 'SoftBank 830P' },
		{ vendorId: 0x04DA, productId: 0x2173, name: 'SoftBank 831P' },
		...CDC_ACM_DEVICE_RULES,
	];
	static readonly usbFilters: readonly USBDeviceFilter[] = [
		{ classCode: COMMUNICATIONS_CLASS, subclassCode: ACM_SUBCLASS },
		...CDC_ACM_DEVICE_RULES
			.filter(rule => rule.quirk === 'no-union-01' || rule.quirk === 'no-union-12')
			.map(rule => ({ vendorId: rule.vendorId, productId: rule.productId })),
	];

	static matches(device: USBDevice): boolean {
		return findConnections(device).length > 0;
	}

	static getInterfaceNumbers(device: USBDevice): readonly number[] {
		return findConnections(device).map(connection => connection.control.interfaceNumber);
	}

	private control = CONTROL_DTR | CONTROL_RTS;
	private status: PortStatus = { cts: false, dsr: false, dcd: false };
	private notification = new Uint8Array();
	private bulkInRecovery?: Promise<void>;
	private quirk?: CDCACMQuirk;

	protected get bulkReadCount(): number {
		return this.quirk === 'single-read' ? 1 : 16;
	}

	protected get bulkReadLength(): number {
		const packets = this.quirk === 'single-read' ? 1 : 2;
		return (this.port?.inEndpoint.packetSize ?? 64) * packets;
	}

	protected get bulkWriteLength(): number {
		return (this.port?.outEndpoint.packetSize ?? 64) * 20;
	}

	protected encodeOutput(data: Uint8Array): readonly Uint8Array[] {
		if (this.quirk === 'zero-packet' && data.byteLength % this.requirePort().outEndpoint.packetSize === 0)
			return [data, new Uint8Array()];
		return [data];
	}

	protected selectPort(): BulkSerialPort {
		const connections = findConnections(this.device);
		const connection = this.requestedInterfaceNumber === undefined ? connections[0] :
			connections.find(item => item.control.interfaceNumber === this.requestedInterfaceNumber);
		if (!connection)
			throw new WebUSBError('CDC-ACM control/data interfaces were not found');
		const dataEndpoints = activeAlternate(connection.data).endpoints;
		const inEndpoint = dataEndpoints.find(endpoint => endpoint.direction === 'in' && endpoint.type !== 'isochronous');
		const outEndpoint = dataEndpoints.find(endpoint => endpoint.direction === 'out' && endpoint.type !== 'isochronous');
		const statusEndpoint = activeAlternate(connection.control).endpoints.find(
			endpoint => endpoint.direction === 'in' && endpoint.type === 'interrupt',
		);
		if (!inEndpoint || !outEndpoint || !statusEndpoint)
			throw new WebUSBError('CDC-ACM endpoints were not found');
		const interfaceNumbers = connection.control === connection.data ? [connection.control.interfaceNumber] :
			[connection.control.interfaceNumber, connection.data.interfaceNumber];
		return {
			interfaceNumbers,
			controlInterfaceNumber: connection.control.interfaceNumber,
			inEndpoint,
			outEndpoint,
			statusEndpoint,
		};
	}

	protected async initialize(options: USBSerialOpenOptions): Promise<number> {
		this.quirk = deviceRule(this.device)?.quirk;
		if (this.quirk === 'clear-halt') {
			await this.device.clearHalt('in', this.requirePort().inEndpoint.endpointNumber);
			await this.device.clearHalt('out', this.requirePort().outEndpoint.endpointNumber);
		}
		await this.setLineCoding({ ...options, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
		if (this.quirk !== 'no-control-line')
			await this.writeControl();
		const baudRate = await this.configure(options);
		if (debug.enabled)
			debug('interfaces %o at %d baud', this.requirePort().interfaceNumbers, baudRate);
		return baudRate;
	}

	protected async configure(options: USBSerialOpenOptions): Promise<number> {
		await this.setLineCoding(options);
		return options.baudRate;
	}

	protected async setSignals(options: SetOptions): Promise<void> {
		if (options.dtr !== undefined)
			this.control = options.dtr ? this.control | CONTROL_DTR : this.control & ~CONTROL_DTR;
		if (options.rts !== undefined)
			this.control = options.rts ? this.control | CONTROL_RTS : this.control & ~CONTROL_RTS;
		if ((options.dtr !== undefined || options.rts !== undefined) && this.quirk !== 'no-control-line')
			await this.writeControl();
		if (options.brk !== undefined)
			await this.classOut(SEND_BREAK, options.brk ? 0xFFFF : 0);
	}

	protected async readStatus(): Promise<PortStatus> {
		return this.status;
	}

	protected processStatus(data: Uint8Array): void {
		if (!this.notification.length && data.length < 8)
			throw new WebUSBError(`CDC-ACM notification header is too short: ${data.length}`, { cause: data });
		const header = this.notification.length ? this.notification : data;
		const length = 8 + (header[6] | header[7] << 8);
		const available = Math.min(data.length, length - this.notification.length);
		const notification = new Uint8Array(this.notification.length + available);
		notification.set(this.notification);
		notification.set(data.subarray(0, available), this.notification.length);
		if (notification.length < length) {
			this.notification = notification;
			return;
		}
		this.notification = new Uint8Array();
		if (notification[1] !== SERIAL_STATE)
			return;
		if (length !== 10)
			throw new WebUSBError(`CDC-ACM serial-state notification has ${length - 8} data bytes`, {
				cause: notification,
			});
		const state = notification[8] | notification[9] << 8;
		this.status = {
			cts: false,
			dsr: Boolean(state & STATE_DSR),
			dcd: Boolean(state & STATE_DCD),
		};
	}

	protected async recoverBulkIn(result: USBInTransferResult): Promise<boolean> {
		if (result.status !== 'stall')
			return false;
		this.bulkInRecovery ??= this.device.clearHalt(
			'in', this.requirePort().inEndpoint.endpointNumber,
		).finally(() => { this.bulkInRecovery = undefined; });
		await this.bulkInRecovery;
		return true;
	}

	private setLineCoding(options: USBSerialOpenOptions): Promise<void> {
		return this.classOut(SET_LINE_CODING, 0, encodeLineCoding(options));
	}

	private writeControl(): Promise<void> {
		return this.classOut(SET_CONTROL_LINE_STATE, this.control);
	}

	private async classOut(request: number, value: number, data?: Uint8Array): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: 'class', recipient: 'interface', request, value,
			index: this.requirePort().controlInterfaceNumber,
		}, data ? webUSBBytes(data) : undefined);
		if (result.status !== 'ok' || result.bytesWritten !== (data?.byteLength ?? 0))
			throw new WebUSBError(`CDC-ACM request 0x${request.toString(16)} failed`, { cause: result });
	}
}
