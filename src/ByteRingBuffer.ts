export class ByteRingBuffer {
	private buffer: Uint8Array;
	private start = 0;
	private size = 0;

	constructor(capacity: number) {
		this.buffer = new Uint8Array(capacity);
	}

	write(data: Uint8Array): void {
		this.reserve(this.size + data.length);
		const capacity = this.buffer.length;
		const end = (this.start + this.size) % capacity;
		const first = capacity - end;
		if (data.length <= first) {
			this.buffer.set(data, end);
		} else {
			this.buffer.set(data.subarray(0, first), end);
			this.buffer.set(data.subarray(first), 0);
		}
		this.size += data.length;
	}

	read(target: Uint8Array, offset: number, length: number): number {
		const count = Math.min(length, this.size);
		const first = Math.min(count, this.buffer.length - this.start);
		target.set(this.buffer.subarray(this.start, this.start + first), offset);
		if (first < count)
			target.set(this.buffer.subarray(0, count - first), offset + first);
		this.size -= count;
		this.start = this.size === 0 ? 0 : (this.start + count) % this.buffer.length;
		return count;
	}

	clear(): void {
		this.start = 0;
		this.size = 0;
	}

	private reserve(required: number): void {
		let capacity = this.buffer.length;
		if (required <= capacity)
			return;
		while (capacity < required)
			capacity *= 2;
		const buffer = new Uint8Array(capacity);
		const size = this.size;
		this.read(buffer, 0, size);
		this.buffer = buffer;
		this.start = 0;
		this.size = size;
	}
}
