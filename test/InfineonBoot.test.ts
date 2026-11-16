import { describe, expect, it, vi } from 'vitest';
import { createWebUSBBinding } from '../src/binding.js';
import { getUSBSerialDriverType } from '../src/drivers/registry.js';
import type { WebUSBPortBinding } from '../src/index.js';
import { USBSerialDevice, type USBSerialDeviceKind } from './USBSerialDevice.js';
import { WebUSBEmulator } from './WebUSBEmulator.js';

const BOOT_LOADERS: readonly { kind: USBSerialDeviceKind, inEndpoint: number, outEndpoint: number }[] = [
	{ kind: 'infineon-brom', inEndpoint: 1, outEndpoint: 2 },
	{ kind: 'infineon-bootcore', inEndpoint: 3, outEndpoint: 4 },
];

async function readExact(binding: WebUSBPortBinding, length: number): Promise<Buffer> {
	const result = Buffer.alloc(length);
	let offset = 0;
	while (offset < length)
		offset += (await binding.read(result, offset, length - offset)).bytesRead;
	return result;
}

async function openBootLoader(device: USBSerialDevice): Promise<WebUSBPortBinding> {
	const webUSB = createWebUSBBinding(() => new WebUSBEmulator([device]));
	const ports = await webUSB.list();
	expect(ports).toHaveLength(1);
	return webUSB.open({ path: ports[0].path, baudRate: 115200 });
}

describe.each(BOOT_LOADERS)('$kind', ({ kind, inEndpoint, outEndpoint }) => {
	it('uses only the bulk endpoints of interface 0', async () => {
		const device = new USBSerialDevice(kind);
		const claimInterface = vi.spyOn(device, 'claimInterface');
		const transferIn = vi.spyOn(device, 'transferIn');
		const transferOut = vi.spyOn(device, 'transferOut');
		expect(getUSBSerialDriverType(device)).toBe('infineon-boot');

		const binding = await openBootLoader(device);
		try {
			await binding.write(Buffer.from('AT'));
			expect(claimInterface.mock.calls).toEqual([[0]]);
			expect(new Set(transferIn.mock.calls.map(([endpoint]) => endpoint))).toEqual(new Set([inEndpoint]));
			expect(transferOut.mock.calls.map(([endpoint]) => endpoint)).toEqual([outEndpoint]);
		} finally {
			await binding.close();
		}
	});

	it('does not send control transfers', async () => {
		const device = new USBSerialDevice(kind);
		const controlTransferIn = vi.spyOn(device, 'controlTransferIn');
		const controlTransferOut = vi.spyOn(device, 'controlTransferOut');
		const selectAlternateInterface = vi.spyOn(device, 'selectAlternateInterface');

		const binding = await openBootLoader(device);
		await binding.write(Buffer.from('AT'));
		expect(await readExact(binding, 2)).toEqual(Buffer.from('AT'));
		await binding.update({ baudRate: 921600 });
		await binding.set({ dtr: true, rts: true, brk: false });
		expect(await binding.get()).toEqual({ cts: true, dsr: true, dcd: false });
		await binding.close();

		expect(controlTransferIn).not.toHaveBeenCalled();
		expect(controlTransferOut).not.toHaveBeenCalled();
		expect(selectAlternateInterface).not.toHaveBeenCalled();
	});

	it('keeps the active configuration', async () => {
		const device = new USBSerialDevice(kind);
		await device.open();
		await device.selectConfiguration(1);
		await device.close();
		const selectConfiguration = vi.spyOn(device, 'selectConfiguration');

		const binding = await openBootLoader(device);
		await binding.close();

		expect(selectConfiguration).not.toHaveBeenCalled();
	});

	it('delivers packet-sized responses without a zero-length packet', async () => {
		const device = new USBSerialDevice(kind);
		const binding = await openBootLoader(device);
		try {
			for (const length of [64, 128]) {
				const payload = Buffer.from(Uint8Array.from({ length }, (_, index) => index));
				await binding.write(payload);
				expect(await readExact(binding, length)).toEqual(payload);
			}
		} finally {
			await binding.close();
		}
	});
});
