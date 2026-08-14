import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type {
	RealtimeAsrTransportHandlers,
	RealtimeAsrTransportConnectOptions,
	RealtimeAsrWebSocketTransport,
} from './realtime-asr-types';
import { RealtimeAsrTransportError } from './realtime-asr-types';

type WsConstructor = typeof WebSocket;
type WsInstance = InstanceType<WsConstructor>;

export type RealtimeAsrWsLoader = () => Promise<WsConstructor>;

export function createNodeRealtimeAsrTransport(
	loadWs: RealtimeAsrWsLoader = loadBundledWs,
): RealtimeAsrWebSocketTransport {
	return new NodeRealtimeAsrTransport(loadWs);
}

export async function loadBundledWs(): Promise<WsConstructor> {
	const module = await import('ws');
	return module.default;
}

class NodeRealtimeAsrTransport implements RealtimeAsrWebSocketTransport {
	private socket: WsInstance | null = null;
	private disposed = false;
	private negotiatedPerMessageDeflate = false;
	private readonly pendingSends = new Set<(error: RealtimeAsrTransportError) => void>();

	constructor(private readonly loadWs: RealtimeAsrWsLoader) {}

	get bufferedAmount(): number {
		return this.socket?.bufferedAmount ?? 0;
	}

	get perMessageDeflateConfigured(): boolean {
		return false;
	}

	get perMessageDeflateNegotiated(): boolean {
		return this.negotiatedPerMessageDeflate;
	}

	async connect(options: RealtimeAsrTransportConnectOptions): Promise<void> {
		if (this.disposed || this.socket) {
			throw new RealtimeAsrTransportError('connection-failed');
		}
		const endpoint = options.endpoint;
		const signal = options.signal;
		const handlers = options.handlers;
		let authorization = options.authorization;
		const Ws = await this.loadWs();
		if (signal.aborted || this.disposed) {
			authorization = '';
			throw new RealtimeAsrTransportError('connection-failed');
		}
		const socket = new Ws(endpoint, {
			headers: { Authorization: authorization },
			maxPayload: 256 * 1024,
			perMessageDeflate: false,
		});
		authorization = '';
		this.socket = socket;
		try {
			await connectSocket(socket, signal, handlers, () => this.disposed || socket !== this.socket);
			this.negotiatedPerMessageDeflate = hasPerMessageDeflate(socket.extensions);
			if (this.negotiatedPerMessageDeflate) {
				throw new RealtimeAsrTransportError('unexpected-websocket-compression');
			}
		} catch (error) {
			if (this.socket === socket) this.socket = null;
			socket.terminate();
			throw error;
		}
	}

	sendText(message: string): Promise<void> {
		return this.send(message, false);
	}

	sendBinary(data: Uint8Array): Promise<void> {
		return this.send(data, true);
	}

	close(): void {
		const socket = this.socket;
		this.socket = null;
		this.rejectPendingSends();
		if (socket && socket.readyState !== socket.CLOSED) {
			socket.close(1000);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const socket = this.socket;
		this.socket = null;
		this.rejectPendingSends();
		socket?.terminate();
	}

	private send(data: string | Uint8Array, binary: boolean): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.readyState !== socket.OPEN || this.disposed) {
			return Promise.reject(new RealtimeAsrTransportError('remote-closed'));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: RealtimeAsrTransportError) => {
				if (settled) return;
				settled = true;
				this.pendingSends.delete(cancel);
				if (error) reject(error); else resolve();
			};
			const cancel = (error: RealtimeAsrTransportError) => finish(error);
			this.pendingSends.add(cancel);
			try {
				socket.send(data, { binary, compress: false }, (error) => finish(
					error ? new RealtimeAsrTransportError('connection-failed') : undefined,
				));
			} catch {
				finish(new RealtimeAsrTransportError('connection-failed'));
			}
		});
	}

	private rejectPendingSends(): void {
		const error = new RealtimeAsrTransportError('remote-closed');
		for (const cancel of [...this.pendingSends]) cancel(error);
	}
}

function hasPerMessageDeflate(extensions: string): boolean {
	return extensions
		.split(',')
		.some((extension) => extension.trim().toLowerCase() === 'permessage-deflate');
}

function connectSocket(
	socket: WsInstance,
	signal: AbortSignal,
	handlers: RealtimeAsrTransportHandlers,
	isInactive: () => boolean,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: RealtimeAsrTransportError) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', abort);
			if (error) reject(error); else resolve();
		};
		const abort = () => {
			socket.terminate();
			finish(new RealtimeAsrTransportError('connection-failed'));
		};
		socket.once('open', () => finish());
		socket.once('unexpected-response', (_request, response) => {
			const code = response.statusCode;
			response.resume();
			socket.terminate();
			finish(new RealtimeAsrTransportError(
				code === 401 || code === 403 ? 'auth-failed' : 'connection-failed',
			));
		});
		socket.on('message', (data, isBinary) => {
			if (isInactive()) return;
			if (isBinary) {
				const bytes = data instanceof ArrayBuffer
					? new Uint8Array(data)
					: ArrayBuffer.isView(data)
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(0);
				handlers.onBinary(bytes);
			} else {
				handlers.onText(decodeTextData(data));
			}
		});
		socket.on('error', () => {
			if (!settled) {
				finish(new RealtimeAsrTransportError('connection-failed'));
			} else if (!isInactive()) {
				handlers.onError(new RealtimeAsrTransportError('connection-failed'));
			}
		});
		socket.on('close', (code) => {
			if (!settled) {
				finish(new RealtimeAsrTransportError('remote-closed'));
			} else if (!isInactive()) {
				handlers.onClose(code);
			}
		});
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	});
}

function decodeTextData(data: RawData): string {
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (Array.isArray(data)) {
		const length = data.reduce((total, part) => total + part.byteLength, 0);
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const part of data) {
			bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
			offset += part.byteLength;
		}
		return new TextDecoder().decode(bytes);
	}
	return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}
