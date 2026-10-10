/// <reference types="w3c-web-usb" />

import type {
	BindingInterface,
	BindingPortInterface,
	OpenOptions,
	PortInfo,
} from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };

export interface WebUSBOpenOptions extends OpenOptions {
	parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
	usbRequestOptions?: USBDeviceRequestOptions;
	usbDevice?: USBDevice;
	usbInterfaceNumber?: number;
}

export interface WebUSBPortInfo extends PortInfo {
	nativeDevice: USBDevice;
	interfaceNumber: number;
}

export type WebUSBPortBinding = BindingPortInterface;

export type WebUSBBindingInterface = BindingInterface<
	WebUSBPortBinding,
	WebUSBOpenOptions,
	WebUSBPortInfo
>;

export interface ResolvedWebUSBOpenOptions extends Required<OpenOptions> {
	parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
	usbRequestOptions: USBDeviceRequestOptions;
	usbDevice?: USBDevice;
	usbInterfaceNumber?: number;
}
