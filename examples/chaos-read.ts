import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { SerialPortStream } from '@serialport/stream';
import { AsyncSerialPort } from '@sie-js/serial';
import { WebUSBBinding, type WebUSBBindingInterface } from '../src/node.js';
import { readChaosMemory } from '../test/PhoneTests.js';

if (process.env.WEBUSB_CHAOS_READ !== '1') {
	throw new Error('Set WEBUSB_CHAOS_READ=1 to run the read-only Chaos flash probe');
}

const argv = parseArgs({
	options: {
		port: { type: 'string' },
		baudRate: { type: 'string', default: '1625000' },
		address: { type: 'string', default: '0xA0000000' },
		size: { type: 'string', default: (1024 * 1024).toString() },
		output: { type: 'string', default: 'flash.bin' },
	},
});

const path = argv.values.port ?? (await WebUSBBinding.list())[0]?.path;
if (!path)
	throw new Error('No accessible supported USB serial device found');

const nativePort = new SerialPortStream<WebUSBBindingInterface>({
	binding: WebUSBBinding,
	path,
	baudRate: 115200,
	autoOpen: false,
});
const port = new AsyncSerialPort(nativePort);

try {
	await port.open();
	const address = Number.parseInt(argv.values.address);
	const size = Number.parseInt(argv.values.size, 10);
	const result = await readChaosMemory(
		port,
		address,
		size,
		Number.parseInt(argv.values.baudRate, 10),
		({ percent, speed, remaining }) => {
			console.log(
				`${percent.toFixed(2)}% | ${(speed / 1024).toFixed(2)} KiB/s | ETA ${remaining.toFixed(2)}s`,
			);
		},
	);
	await fs.writeFile(argv.values.output, result);
} finally {
	if (port.isOpen)
		await port.close();
}
