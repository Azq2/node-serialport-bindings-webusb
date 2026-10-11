import { WebUSB, type Device, type Endpoint, type Transfer } from 'usb';
import { WEBUSB_SERIAL_FILTERS } from './drivers/registry.js';
import { WebUSBError } from './WebUSBError.js';

// usb 2.x decodeVersion() parses the major byte as decimal, e.g. 0x10 becomes 10.
export function restoreVersionMajors(
	device: USBDevice,
	descriptor: Pick<Device['deviceDescriptor'], 'bcdUSB' | 'bcdDevice'>,
): void {
	Object.defineProperties(device, {
		usbVersionMajor: { value: descriptor.bcdUSB >> 8 },
		deviceVersionMajor: { value: descriptor.bcdDevice >> 8 },
	});
}

// usb 2.x close() does not cancel ordinary endpoint transfers before releasing interfaces.
function cancelTransfersOnClose(device: USBDevice, nativeDevice: Device): void {
	const pending = new Set<Transfer>();
	const trackedEndpoints = new WeakSet<Endpoint>();
	let drained: (() => void) | undefined;
	let closing: Promise<void> | undefined;

	function trackEndpoints(): void {
		for (const iface of nativeDevice.interfaces ?? []) {
			for (const endpoint of iface.endpoints) {
				if (trackedEndpoints.has(endpoint))
					continue;
				trackedEndpoints.add(endpoint);
				const makeTransfer = endpoint.makeTransfer.bind(endpoint);
				const slots: Array<{
					transfer: Transfer;
					timeout: number;
					isActive(): boolean;
					setCallback(callback: Parameters<Endpoint['makeTransfer']>[1]): void;
				}> = [];
				endpoint.makeTransfer = (timeout, callback) => {
					let slot = slots.find(candidate => candidate.timeout === timeout && !candidate.isActive());
					if (!slot) {
						let active = false;
						let currentCallback: Parameters<Endpoint['makeTransfer']>[1] | undefined;
						const transfer = makeTransfer(timeout, function(this: Transfer, error, buffer, actualLength) {
							pending.delete(this);
							active = false;
							const completedCallback = currentCallback;
							currentCallback = undefined;
							try {
								completedCallback?.(error, buffer, actualLength);
							} finally {
								if (pending.size === 0)
									drained?.();
							}
						});
						const nativeSubmit = transfer.submit.bind(transfer);
						const submit: Transfer['submit'] = (buffer, submitCallback) => {
							active = true;
							pending.add(transfer);
							try {
								return nativeSubmit(buffer, submitCallback);
							} catch (error) {
								active = false;
								currentCallback = undefined;
								pending.delete(transfer);
								throw error;
							}
						};
						Object.defineProperty(transfer, 'submit', { value: submit });
						slot = {
							transfer,
							timeout,
							isActive: () => active,
							setCallback: nextCallback => { currentCallback = nextCallback; },
						};
						slots.push(slot);
					}
					slot.setCallback(callback);
					return slot.transfer;
				};
			}
		}
	}

	const claimInterface = device.claimInterface.bind(device);
	device.claimInterface = async interfaceNumber => {
		await claimInterface(interfaceNumber);
		trackEndpoints();
	};
	const selectAlternateInterface = device.selectAlternateInterface.bind(device);
	device.selectAlternateInterface = async (interfaceNumber, alternateSetting) => {
		await selectAlternateInterface(interfaceNumber, alternateSetting);
		trackEndpoints();
	};

	const close = device.close.bind(device);
	async function closeDevice(): Promise<void> {
		if (pending.size > 0) {
			const completed = new Promise<void>(resolve => { drained = resolve; });
			try {
				for (const transfer of pending)
					transfer.cancel();
				await completed;
			} finally {
				drained = undefined;
			}
		}
		await close();
	}
	device.close = () => {
		closing ??= closeDevice().finally(() => { closing = undefined; });
		return closing;
	};
}

export class NodeWebUSB extends WebUSB {
	private readonly adaptedDevices = new WeakSet<USBDevice>();

	constructor() {
		super({ allowedDevices: [...WEBUSB_SERIAL_FILTERS] });
	}

	override async getDevices(): Promise<USBDevice[]> {
		const devices = await super.getDevices();
		this.adaptDevices();
		return devices;
	}

	override requestDevice(): Promise<USBDevice> {
		return Promise.reject(new WebUSBError(
			'webusb://any is only available in a browser; pass usbDevice or use a path returned by WebUSBBinding.list()',
		));
	}

	private adaptDevices(): void {
		for (const [nativeDevice, device] of this.knownDevices) {
			if (!this.adaptedDevices.has(device)) {
				restoreVersionMajors(device, nativeDevice.deviceDescriptor);
				cancelTransfersOnClose(device, nativeDevice);
				this.adaptedDevices.add(device);
			}
		}
	}
}
