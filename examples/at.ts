import { SerialPortStream } from '@serialport/stream';
import { WebUSBBinding, type WebUSBBindingInterface } from 'serialport-bindings-webusb';

const path = process.argv[2] ?? (await WebUSBBinding.list())[0]?.path;
if (!path)
	throw new Error('No supported USB serial device found');

const serialPort = new SerialPortStream<WebUSBBindingInterface>({
	binding: WebUSBBinding,
	path,
	baudRate: 115200,
});

serialPort.on('open', () => serialPort.write('AT+CGMM\r'));

let response = '';
serialPort.on('data', (data: Buffer) => {
	process.stdout.write(data);
	response += data.toString();
	if (response.includes('\r\nOK\r\n') || response.includes('\r\nERROR\r\n'))
		serialPort.close();
});
