import type { USBSerialDeviceInfo } from '../types.js';

export type CDCACMQuirk = 'no-union-01' | 'no-union-12' | 'single-read' | 'no-control-line' |
	'clear-halt' | 'zero-packet' | 'vendor-data';

export interface CDCACMDeviceRule extends USBSerialDeviceInfo {
	readonly quirk?: CDCACMQuirk;
	readonly vendorProtocol?: boolean;
}

const nokiaProductIds = [
	0x0001, 0x0007, 0x000E, 0x002F, 0x003A, 0x0042, 0x0070, 0x0071, 0x007B, 0x0088, 0x008F,
	0x0094, 0x0099, 0x00A0, 0x00AB, 0x00B0, 0x00E9, 0x00FC, 0x0108, 0x010E, 0x0128, 0x0134,
	0x0154, 0x0178, 0x01D0, 0x01D4, 0x01F5, 0x0223, 0x026C, 0x0275, 0x02D9, 0x02E3, 0x0302,
	0x0335, 0x03CD, 0x0418, 0x0419, 0x0420, 0x0425, 0x042D, 0x042F, 0x0445, 0x044D, 0x046E,
	0x0475, 0x0481, 0x0486, 0x048E, 0x04B2, 0x04C9, 0x04CE, 0x04D8, 0x04DF, 0x04E6, 0x04F0,
	0x0508,
];

// Linux drivers/usb/class/cdc-acm.c, commit c18f03ded7972cacf7e3888573fef5293eb9500b.
export const CDC_ACM_DEVICE_RULES: readonly CDCACMDeviceRule[] = [
	...nokiaProductIds.map(productId => ({
		vendorId: 0x0421, productId, name: 'Nokia PC Suite ACM', vendorProtocol: true,
	})),
	{ vendorId: 0x03EB, productId: 0x0030, name: 'Owen SI30' },
	{ vendorId: 0x0424, productId: 0x274E, name: 'Microchip CDC ACM' },
	{ vendorId: 0x045B, productId: 0x023C, name: 'Renesas R-Car H3 USB Download' },
	{ vendorId: 0x045B, productId: 0x0247, name: 'Renesas R-Car D3 USB Download' },
	{ vendorId: 0x045B, productId: 0x0248, name: 'Renesas R-Car M3-N USB Download' },
	{ vendorId: 0x045B, productId: 0x024D, name: 'Renesas R-Car E3 USB Download' },
	{ vendorId: 0x0482, productId: 0x0203, name: 'Kyocera AH-K3001V', quirk: 'no-union-01' },
	{ vendorId: 0x04B8, productId: 0x0D12, name: 'Epson HMD Com&Sens', quirk: 'no-union-12' },
	{ vendorId: 0x04E7, productId: 0x6651, name: 'Samsung PC Suite ACM', vendorProtocol: true },
	{ vendorId: 0x0572, productId: 0x1321, name: 'Conexant CX93010', quirk: 'no-union-01' },
	{ vendorId: 0x0572, productId: 0x1324, name: 'Conexant RD02-D400', quirk: 'no-union-01' },
	{ vendorId: 0x0572, productId: 0x1328, name: 'Shiro UM-3100', quirk: 'no-union-01' },
	{ vendorId: 0x0572, productId: 0x1329, name: 'Hummingbird HUC56S', quirk: 'no-union-01' },
	{ vendorId: 0x0572, productId: 0x1340, name: 'Conexant CX93010-2x', quirk: 'no-union-01' },
	{ vendorId: 0x0572, productId: 0x1349, name: 'Hiro H50228', quirk: 'no-union-01' },
	{ vendorId: 0x05F9, productId: 0x4002, name: 'Magellan 800i', quirk: 'no-union-01' },
	{ vendorId: 0x076D, productId: 0x0006, name: 'Denso CU-321', quirk: 'no-union-01' },
	{ vendorId: 0x079B, productId: 0x000F, name: 'BT On-Air USB Modem', quirk: 'no-union-01' },
	{ vendorId: 0x0803, productId: 0x3095, name: 'Zoom 3095F USB Modem', quirk: 'no-union-01' },
	{ vendorId: 0x0870, productId: 0x0001, name: 'Metricom GS Modem', quirk: 'no-union-01' },
	{ vendorId: 0x09D8, productId: 0x0320, name: 'Elatec TWN3', quirk: 'no-union-01' },
	{ vendorId: 0x0ACE, productId: 0x1602, name: 'ZyDAS USB Modem', quirk: 'single-read' },
	{ vendorId: 0x0ACE, productId: 0x1608, name: 'ZyDAS USB Modem', quirk: 'single-read' },
	{ vendorId: 0x0ACE, productId: 0x1611, name: 'ZyDAS USB Modem', quirk: 'single-read' },
	{ vendorId: 0x0C26, productId: 0x0020, name: 'Icom ICF3400', quirk: 'no-union-01' },
	{ vendorId: 0x0CA6, productId: 0xA050, name: 'Castles VEGA3000', quirk: 'no-union-01' },
	{ vendorId: 0x0E8D, productId: 0x0003, name: 'MediaTek FIREFLY', quirk: 'no-union-01' },
	{ vendorId: 0x0E8D, productId: 0x2000, name: 'MediaTek Preloader' },
	{ vendorId: 0x0E8D, productId: 0x3329, name: 'MediaTek GPS', quirk: 'no-union-01' },
	{ vendorId: 0x11CA, productId: 0x0201, name: 'VeriFone Mx870', quirk: 'single-read' },
	{ vendorId: 0x1519, productId: 0x0452, name: 'Intel 7260 Modem', quirk: 'zero-packet' },
	{ vendorId: 0x1576, productId: 0x03B1, name: 'Maretron USB100', quirk: 'no-union-01' },
	{ vendorId: 0x17EF, productId: 0x6161, name: 'Lenovo Yoga Book CDC ACM', quirk: 'vendor-data' },
	{ vendorId: 0x17EF, productId: 0x7000, name: 'Lenovo USB Modem', quirk: 'no-union-01' },
	{ vendorId: 0x1901, productId: 0x0006, name: 'GE Patient Monitor' },
	{ vendorId: 0x1965, productId: 0x0017, name: 'Uniden BC125AT', quirk: 'no-union-01' },
	{ vendorId: 0x1965, productId: 0x0018, name: 'Uniden UBC125XLT', quirk: 'no-union-01' },
	{ vendorId: 0x1A86, productId: 0x55D3, name: 'CH343 CDC ACM' },
	{ vendorId: 0x1BBB, productId: 0x0003, name: 'Alcatel OT-I650', quirk: 'no-union-01' },
	{ vendorId: 0x1BC7, productId: 0x0021, name: 'Telit 3G ACM', quirk: 'zero-packet' },
	{ vendorId: 0x1BC7, productId: 0x0023, name: 'Telit 3G ACM/ECM', quirk: 'zero-packet' },
	{ vendorId: 0x20DF, productId: 0x0001, name: 'Simtec Entropy Key', quirk: 'no-control-line' },
	{ vendorId: 0x2184, productId: 0x001C, name: 'GW Instek AFG-2225' },
	{ vendorId: 0x2184, productId: 0x0036, name: 'GW Instek AFG-125' },
	{ vendorId: 0x22B8, productId: 0x2D91, name: 'Motorola H24 Modem' },
	{ vendorId: 0x22B8, productId: 0x2D92, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D93, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D95, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D96, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D97, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D99, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x2D9A, name: 'Motorola H24 Modem', quirk: 'no-union-01' },
	{ vendorId: 0x22B8, productId: 0x6425, name: 'Motorola MOTOMAGX' },
	{ vendorId: 0x22B8, productId: 0x7000, name: 'Motorola Q Phone', quirk: 'no-union-01' },
	{ vendorId: 0x2912, productId: 0x0001, name: 'ATOL FPrint', quirk: 'clear-halt' },
	{ vendorId: 0xFFF0, productId: 0x0100, name: 'DATECS FP-2000', quirk: 'no-union-01' },
];
