# SUMMARY

[![NPM Version](https://img.shields.io/npm/v/serialport-bindings-webusb)](https://www.npmjs.com/package/serialport-bindings-webusb)

[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) bindings for [SerialPort](https://serialport.io/).
Works with `navigator.usb` in Chromium and with `usb` 2.x in NodeJS.

Supported drivers:

- PL2303 and PL256X
- CH340 and CH341
- CP210x
- FTDI
- CDC-ACM

# INSTALL

For browsers:

```sh
pnpm add serialport-bindings-webusb @serialport/stream
```

For NodeJS, add `usb`:

```sh
pnpm add serialport-bindings-webusb @serialport/stream usb@^2.18.0
```

# EXAMPLES

1. List devices:

   ```ts
   import { WebUSBBinding } from 'serialport-bindings-webusb';

   const ports = await WebUSBBinding.list();
   console.log(ports);
   ```

   In a browser, `list()` only returns devices the user has already allowed.

2. Open the browser device chooser:

   ```ts
   import { SerialPortStream } from '@serialport/stream';
   import {
   	WebUSBBinding,
   	type WebUSBBindingInterface,
   } from 'serialport-bindings-webusb';

   const port = new SerialPortStream<WebUSBBindingInterface>({
   	binding: WebUSBBinding,
   	path: 'webusb://any',
   	baudRate: 115200,
   });
   ```

   `webusb://any` is only available in a browser and must be opened from a user gesture.
   In NodeJS, use a path returned by `list()`.

3. Open the browser device chooser with custom filters:

   ```ts
   const port = new SerialPortStream<WebUSBBindingInterface>({
   	binding: WebUSBBinding,
   	path: 'webusb://any',
   	baudRate: 115200,
   	usbRequestOptions: {
   		filters: [{ vendorId: 0x067B, productId: 0x2303 }],
   	},
   });
   ```

4. Open a `USBDevice` returned by `navigator.usb`:

   ```ts
   import { WEBUSB_SERIAL_FILTERS } from 'serialport-bindings-webusb';

   const usbDevice = await navigator.usb.requestDevice({
   	filters: [...WEBUSB_SERIAL_FILTERS],
   });

   const port = new SerialPortStream<WebUSBBindingInterface>({
   	binding: WebUSBBinding,
   	path: 'webusb://any',
   	baudRate: 115200,
   	usbDevice,
   });
   ```

5. Open a device by URI:

   ```ts
   const port = new SerialPortStream<WebUSBBindingInterface>({
   	binding: WebUSBBinding,
   	path: 'webusb://device?vid=0403&pid=6001',
   	baudRate: 115200,
   });
   ```

   Device paths use this format:

   ```text
   webusb://device?vid=<VID>&pid=<PID>[&serial=<serial>][&interface=<number>][&instance=<number>]
   ```

   - `vid` and `pid` are required hexadecimal USB IDs
   - `serial` selects a device by its serial number
   - `interface` selects a port on a multi-port device
   - `instance` is added by `list()` when otherwise identical devices are connected

   `WebUSBBinding.list()` returns the full URI for every available port.

# IMPORTANT NOTES

- WebUSB requires a secure context
- Browser builds may need NodeJS polyfills for `@serialport/stream`, such as `vite-plugin-node-polyfills`
- Linux may require a udev rule for USB transfers
- Windows requires a WinUSB-compatible driver.
  See the [node-usb Windows guide](https://github.com/node-usb/node-usb#windows)

# DEBUG

In a browser, enable debug output and reload the page:

```js
localStorage.debug = 'serialport/bindings-webusb*';
```

In NodeJS:

```sh
DEBUG=serialport/bindings-webusb* node app.js
```

# SEE ALSO

[WebSerial bindings for SerialPort](https://github.com/Azq2/node-serialport-bindings-webserial)

# DEVELOPMENT

#### SOFTWARE TESTS

```sh
pnpm test
pnpm test:browser
```

`pnpm test` and `pnpm test:browser` use the software WebUSB emulator and do not access USB hardware.
Browser tests run in Playwright Chromium.

#### HARDWARE TESTS

Browser hardware tests use the system Google Chrome.
Set `WEBUSB_CPU_THROTTLING_RATE=4` to enable CPU throttling.

**Loopback**

Connect the device's RX and TX pins together before running these tests.

```sh
pnpm test:hardware
pnpm test:browser:hardware
```

Use `WEBUSB_DEV` to select a VID:PID:

```sh
WEBUSB_DEV=067B:2303 pnpm test:hardware
WEBUSB_DEV=067B:2303 pnpm test:browser:hardware
```

Use `WEBUSB_BUS` or `WEBUSB_SERIAL` when several devices have the same VID:PID:

```sh
WEBUSB_DEV=067B:2303 WEBUSB_BUS=003 pnpm test:hardware
WEBUSB_DEV=067B:2303 WEBUSB_SERIAL=123456 pnpm test:browser:hardware
```

**Phone tests**

AT tests use the phone's command channel. BFC and Chaos are service protocols used by Siemens mobile phones.
All phone tests require `WEBUSB_DEV`:

```sh
WEBUSB_DEV=11F5:1004 pnpm test:hardware:at
WEBUSB_DEV=11F5:1004 pnpm test:browser:hardware:at
WEBUSB_DEV=11F5:1004 pnpm test:hardware:bfc
WEBUSB_DEV=11F5:1004 pnpm test:browser:hardware:bfc
WEBUSB_DEV=067B:2303 pnpm test:hardware:chaos
WEBUSB_DEV=067B:2303 pnpm test:browser:hardware:chaos
```

**[USB serial emulator](https://github.com/Azq2/usb-serial-emu)**

Firmware for RP2040 boards that emulates USB-to-serial adapters and echoes serial data for loopback testing.

```sh
pnpm test:hardware:usb-serial-emu
pnpm test:browser:hardware:usb-serial-emu
```
