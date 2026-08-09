import { validateAudioCompanionEndpoint } from './audio-companion-endpoint';
import {
	AudioCompanionProtocolError,
	encodeAudioCompanionControlMessage,
	isValidAudioCompanionToken,
	parseAudioCompanionFrame,
	parseAudioCompanionServerMessage,
} from './audio-companion-protocol';
import {
	AUDIO_COMPANION_PROTOCOL_VERSION,
	AUDIO_COMPANION_TARGET_FORMAT,
	type AudioCompanionClientMessage,
	type AudioCompanionClientOptions,
	type AudioCompanionClientState,
	type AudioCompanionClientStatus,
	type AudioCompanionConfiguration,
	type AudioCompanionConfigureResult,
	type AudioCompanionErrorCode,
	type AudioCompanionRemoteErrorCode,
	type AudioCompanionRemoteStatus,
	type AudioCompanionScheduler,
	type AudioCompanionServerMessage,
	type AudioCompanionSessionContext,
	type AudioCompanionSocket,
	type AudioCompanionSource,
	type AudioCompanionStartResult,
	type AudioCompanionUiStatus,
	type AudioCompanionWebSocketFactory,
} from './audio-companion-types';

const CONNECT_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

interface RuntimeConfiguration {
	endpoint: string;
	token: string;
}

interface PendingOperation {
	resolve(): void;
	reject(error: AudioCompanionClientError): void;
}

export class AudioCompanionClientError extends Error {
	constructor(readonly code: AudioCompanionErrorCode) {
		super(audioCompanionErrorMessage(code));
		this.name = 'AudioCompanionClientError';
	}
}

export class AudioCompanionClient {
	private currentState: AudioCompanionClientState = createInitialState(false);
	private readonly listeners = new Set<(state: AudioCompanionClientState) => void>();
	private readonly scheduler: AudioCompanionScheduler;
	private configuration: RuntimeConfiguration | null = null;
	private socket: AudioCompanionSocket | null = null;
	private session: AudioCompanionSessionContext | null = null;
	private connectOperation: PendingOperation | null = null;
	private stopOperation: PendingOperation | null = null;
	private connectTimeout: unknown = null;
	private authTimeout: unknown = null;
	private heartbeatInterval: unknown = null;
	private heartbeatTimeout: unknown = null;
	private stopTimeout: unknown = null;
	private heartbeatId = 0;
	private pendingHeartbeatId: number | null = null;
	private lastSequence = -1;
	private lastOffsetMs = -1;
	private startPending = false;
	private disposed = false;

	constructor(private readonly options: AudioCompanionClientOptions) {
		this.scheduler = options.scheduler ?? createBrowserScheduler();
	}

	get state(): AudioCompanionClientState {
		return cloneState(this.currentState);
	}

	configure(configuration: AudioCompanionConfiguration): AudioCompanionConfigureResult {
		if (this.disposed || isConnectionActive(this.currentState.status)) {
			return { status: 'busy' };
		}
		const endpoint = validateAudioCompanionEndpoint(configuration.endpoint);
		if (!endpoint.valid || !endpoint.endpoint) {
			return { status: 'invalid', code: 'invalid-endpoint' };
		}
		if (!isValidAudioCompanionToken(configuration.token)) {
			return { status: 'invalid', code: 'token-missing' };
		}
		this.configuration = {
			endpoint: endpoint.endpoint,
			token: configuration.token,
		};
		this.setState({
			...createInitialState(true),
			status: this.currentState.status === 'error' ? 'disconnected' : this.currentState.status,
		});
		return { status: 'configured' };
	}

	clearConfiguration(): void {
		this.disconnect();
		this.configuration = null;
		if (!this.disposed) {
			this.setState(createInitialState(false));
		}
	}

	connect(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new AudioCompanionClientError('disposed'));
		}
		if (!this.configuration) {
			return Promise.reject(new AudioCompanionClientError('not-configured'));
		}
		if (isConnectionActive(this.currentState.status) || this.connectOperation) {
			return Promise.reject(new AudioCompanionClientError('busy'));
		}
		const session = this.options.getSessionContext();
		if (!isValidSessionContext(session)) {
			return Promise.reject(new AudioCompanionClientError('session-unavailable'));
		}
		this.session = { ...session };
		this.resetFrameSequence();
		this.setState({
			...createInitialState(true),
			status: 'connecting',
		});

		return new Promise<void>((resolve, reject) => {
			this.connectOperation = { resolve, reject };
			try {
				const socket = this.options.webSocketFactory(this.configuration?.endpoint ?? '');
				this.socket = socket;
				this.installSocketHandlers(socket);
				this.connectTimeout = this.scheduler.setTimeout(() => {
					this.fail('connect-timeout', 'connecting', 'TimeoutError');
				}, CONNECT_TIMEOUT_MS);
			} catch (error) {
				this.fail('connect-failed', 'connecting', safeErrorName(error));
			}
		});
	}

	startCapture(sourceId: AudioCompanionSource): AudioCompanionStartResult {
		if (this.disposed || this.currentState.status !== 'ready') {
			return isConnectionActive(this.currentState.status) ? 'busy' : 'not-ready';
		}
		if (this.startPending) {
			return 'busy';
		}
		if (!this.currentState.supportedSources.includes(sourceId)) {
			return 'source-unavailable';
		}
		const currentSession = this.options.getSessionContext();
		if (!isValidSessionContext(currentSession)
			|| !this.session
			|| currentSession.sessionId !== this.session.sessionId
			|| currentSession.startedAtUnixMs !== this.session.startedAtUnixMs) {
			return 'session-unavailable';
		}
		const captureStartOffsetMs = Math.max(
			0,
			Math.floor(this.scheduler.now() - currentSession.startedAtUnixMs),
		);
		if (!Number.isSafeInteger(captureStartOffsetMs)) {
			return 'session-unavailable';
		}
		this.startPending = true;
		const sent = this.sendControl({
			type: 'START',
			protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
			sessionId: currentSession.sessionId,
			sourceId,
			format: AUDIO_COMPANION_TARGET_FORMAT,
			sessionStartedAtUnixMs: currentSession.startedAtUnixMs,
			captureStartOffsetMs,
		});
		if (!sent) {
			this.startPending = false;
			return 'not-ready';
		}
		return 'starting';
	}

	stopCapture(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new AudioCompanionClientError('disposed'));
		}
		const existingStop = this.stopOperation;
		if (this.currentState.status === 'stopping' && existingStop) {
			return new Promise<void>((resolve, reject) => {
				this.stopOperation = {
					resolve: () => {
						existingStop.resolve();
						resolve();
					},
					reject: (error) => {
						existingStop.reject(error);
						reject(error);
					},
				};
			});
		}
		if (this.currentState.status !== 'capturing' && !this.startPending) {
			return Promise.resolve();
		}
		if (!this.session) {
			return Promise.reject(new AudioCompanionClientError('session-unavailable'));
		}
		this.startPending = false;
		this.setStatus('stopping');
		if (!this.sendControl({
			type: 'STOP',
			protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
			sessionId: this.session.sessionId,
		})) {
			return Promise.reject(new AudioCompanionClientError('unexpected-disconnect'));
		}
		return new Promise<void>((resolve, reject) => {
			this.stopOperation = { resolve, reject };
			this.stopTimeout = this.scheduler.setTimeout(() => {
				this.fail('stop-timeout', 'stopping', 'TimeoutError');
			}, STOP_TIMEOUT_MS);
		});
	}

	disconnect(): void {
		this.rejectPendingOperations('unexpected-disconnect');
		this.clearAllTimers();
		this.closeSocket();
		this.session = null;
		this.startPending = false;
		this.resetFrameSequence();
		if (!this.disposed) {
			this.setState({
				...createInitialState(Boolean(this.configuration)),
				status: 'disconnected',
			});
		}
	}

	subscribe(listener: (state: AudioCompanionClientState) => void): () => void {
		if (this.disposed) {
			return () => undefined;
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.rejectPendingOperations('disposed');
		this.clearAllTimers();
		this.closeSocket();
		this.configuration = null;
		this.session = null;
		this.listeners.clear();
		this.startPending = false;
		this.resetFrameSequence();
	}

	private installSocketHandlers(socket: AudioCompanionSocket): void {
		socket.onOpen = () => this.handleOpen(socket);
		socket.onMessage = (data) => this.handleMessage(socket, data);
		socket.onError = (errorName) => {
			if (socket === this.socket) {
				this.fail('connect-failed', this.currentState.status, errorName);
			}
		};
		socket.onClose = (event) => {
			if (socket === this.socket && !this.disposed) {
				this.socket = null;
				this.fail(
					'unexpected-disconnect',
					this.currentState.status,
					event.wasClean ? 'CloseEvent' : 'UnexpectedCloseEvent',
				);
			}
		};
	}

	private handleOpen(socket: AudioCompanionSocket): void {
		if (socket !== this.socket || this.currentState.status !== 'connecting') {
			return;
		}
		this.clearTimer('connect');
		const configuration = this.configuration;
		const session = this.session;
		if (!configuration || !session) {
			this.fail('not-configured', 'connecting', 'ConfigurationError');
			return;
		}
		this.setStatus('authenticating');
		this.authTimeout = this.scheduler.setTimeout(() => {
			this.fail('auth-timeout', 'authenticating', 'TimeoutError');
		}, AUTH_TIMEOUT_MS);
		this.sendControl({
			type: 'HELLO',
			protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
			sessionId: session.sessionId,
			clientVersion: this.options.clientVersion,
			auth: {
				scheme: 'pairing-token',
				token: configuration.token,
			},
		});
	}

	private handleMessage(socket: AudioCompanionSocket, data: unknown): void {
		if (socket !== this.socket || this.disposed) {
			return;
		}
		try {
			if (typeof data === 'string') {
				this.handleControlMessage(parseAudioCompanionServerMessage(data));
				return;
			}
			if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
				if (this.currentState.status !== 'capturing') {
					throw new AudioCompanionProtocolError('frame-before-capturing');
				}
				const frame = parseAudioCompanionFrame(data);
				if (frame.sequence <= this.lastSequence) {
					throw new AudioCompanionProtocolError('sequence-regression');
				}
				if (frame.offsetMs < this.lastOffsetMs) {
					throw new AudioCompanionProtocolError('offset-regression');
				}
				this.lastSequence = frame.sequence;
				this.lastOffsetMs = frame.offsetMs;
				this.options.onAudioFrame?.(frame);
				return;
			}
			throw new AudioCompanionProtocolError('unsupported-message-data');
		} catch (error) {
			this.fail(
				error instanceof AudioCompanionProtocolError && error.reason === 'protocol-version'
					? 'protocol-incompatible'
					: 'protocol-error',
				this.currentState.status,
				safeErrorName(error),
			);
		}
	}

	private handleControlMessage(message: AudioCompanionServerMessage): void {
		switch (message.type) {
			case 'READY':
				this.handleReady(message);
				return;
			case 'STATUS':
				this.handleRemoteStatus(message.status);
				return;
			case 'ERROR':
				this.handleRemoteError(message.code);
				return;
			case 'PING':
				this.sendControl({
					type: 'PONG',
					protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
					id: message.id,
				});
				return;
			case 'PONG':
				if (message.id !== this.pendingHeartbeatId) {
					throw new AudioCompanionProtocolError('unexpected-pong');
				}
				this.pendingHeartbeatId = null;
				this.clearTimer('heartbeat-timeout');
				return;
		}
	}

	private handleReady(message: Extract<AudioCompanionServerMessage, { type: 'READY' }>): void {
		if (this.currentState.status !== 'authenticating'
			|| !message.capabilities.includes('audio-frame-v1')
			|| !message.capabilities.includes('heartbeat-v1')
			|| message.supportedFormats.length === 0) {
			throw new AudioCompanionProtocolError('unexpected-ready');
		}
		this.clearTimer('auth');
		this.setState({
			status: 'ready',
			configured: true,
			errorCode: null,
			helperVersion: message.helperVersion,
			platform: message.platform,
			supportedSources: [...message.supportedSources],
		});
		this.startHeartbeat();
		const operation = this.connectOperation;
		this.connectOperation = null;
		operation?.resolve();
	}

	private handleRemoteStatus(status: AudioCompanionRemoteStatus): void {
		if (status === 'capturing') {
			if (!this.startPending || this.currentState.status !== 'ready') {
				throw new AudioCompanionProtocolError('unexpected-capturing-status');
			}
			this.startPending = false;
			this.setStatus('capturing');
			return;
		}
		if (status === 'stopped') {
			if (this.currentState.status !== 'stopping') {
				throw new AudioCompanionProtocolError('unexpected-stopped-status');
			}
			this.clearTimer('stop');
			this.resetFrameSequence();
			this.setStatus('ready');
			const operation = this.stopOperation;
			this.stopOperation = null;
			operation?.resolve();
			return;
		}
		if (status === 'error') {
			this.fail('remote-error', this.currentState.status, 'RemoteError');
			return;
		}
		if (status === 'ready' && this.currentState.status === 'ready') {
			return;
		}
		if (status === 'connecting' && this.currentState.status === 'authenticating') {
			return;
		}
		throw new AudioCompanionProtocolError('unexpected-status');
	}

	private handleRemoteError(code: AudioCompanionRemoteErrorCode): void {
		const localCode: AudioCompanionErrorCode = code === 'AUTH_FAILED'
			? 'auth-failed'
			: code === 'PROTOCOL_MISMATCH'
				? 'protocol-incompatible'
				: 'remote-error';
		this.fail(localCode, this.currentState.status, 'RemoteError');
	}

	private startHeartbeat(): void {
		this.clearTimer('heartbeat-interval');
		this.heartbeatInterval = this.scheduler.setInterval(() => {
			if (this.pendingHeartbeatId !== null
				|| (this.currentState.status !== 'ready'
					&& this.currentState.status !== 'capturing'
					&& this.currentState.status !== 'stopping')) {
				return;
			}
			this.heartbeatId += 1;
			this.pendingHeartbeatId = this.heartbeatId;
			if (!this.sendControl({
				type: 'PING',
				protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
				id: this.heartbeatId,
			})) {
				return;
			}
			this.heartbeatTimeout = this.scheduler.setTimeout(() => {
				this.fail('heartbeat-timeout', this.currentState.status, 'TimeoutError');
			}, HEARTBEAT_TIMEOUT_MS);
		}, HEARTBEAT_INTERVAL_MS);
	}

	private sendControl(message: AudioCompanionClientMessage): boolean {
		const socket = this.socket;
		if (!socket) {
			return false;
		}
		try {
			socket.send(encodeAudioCompanionControlMessage(message));
			return true;
		} catch (error) {
			this.fail('unexpected-disconnect', this.currentState.status, safeErrorName(error));
			return false;
		}
	}

	private fail(
		code: AudioCompanionErrorCode,
		stage: AudioCompanionClientStatus,
		type: string,
	): void {
		if (this.disposed) {
			return;
		}
		this.options.onDiagnostic?.({ code, stage, type: sanitizeDiagnosticType(type) });
		this.rejectPendingOperations(code);
		this.clearAllTimers();
		this.closeSocket();
		this.session = null;
		this.startPending = false;
		this.resetFrameSequence();
		this.setState({
			...this.currentState,
			status: 'error',
			errorCode: code,
		});
	}

	private rejectPendingOperations(code: AudioCompanionErrorCode): void {
		const error = new AudioCompanionClientError(code);
		const connect = this.connectOperation;
		const stop = this.stopOperation;
		this.connectOperation = null;
		this.stopOperation = null;
		connect?.reject(error);
		stop?.reject(error);
	}

	private setStatus(status: AudioCompanionClientStatus): void {
		this.setState({ ...this.currentState, status, errorCode: null });
	}

	private setState(state: AudioCompanionClientState): void {
		this.currentState = cloneState(state);
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}

	private resetFrameSequence(): void {
		this.lastSequence = -1;
		this.lastOffsetMs = -1;
	}

	private clearAllTimers(): void {
		this.clearTimer('connect');
		this.clearTimer('auth');
		this.clearTimer('heartbeat-interval');
		this.clearTimer('heartbeat-timeout');
		this.clearTimer('stop');
		this.pendingHeartbeatId = null;
	}

	private clearTimer(
		timer: 'connect' | 'auth' | 'heartbeat-interval' | 'heartbeat-timeout' | 'stop',
	): void {
		if (timer === 'connect' && this.connectTimeout !== null) {
			this.scheduler.clearTimeout(this.connectTimeout);
			this.connectTimeout = null;
		} else if (timer === 'auth' && this.authTimeout !== null) {
			this.scheduler.clearTimeout(this.authTimeout);
			this.authTimeout = null;
		} else if (timer === 'heartbeat-interval' && this.heartbeatInterval !== null) {
			this.scheduler.clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		} else if (timer === 'heartbeat-timeout' && this.heartbeatTimeout !== null) {
			this.scheduler.clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = null;
		} else if (timer === 'stop' && this.stopTimeout !== null) {
			this.scheduler.clearTimeout(this.stopTimeout);
			this.stopTimeout = null;
		}
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = null;
		if (!socket) {
			return;
		}
		socket.onOpen = null;
		socket.onMessage = null;
		socket.onError = null;
		socket.onClose = null;
		try {
			socket.close(1000, 'client-stop');
		} catch {
			// The socket is already unusable; all local resources are detached.
		}
	}
}

export function audioCompanionUiStatus(
	state: AudioCompanionClientState,
): AudioCompanionUiStatus {
	if (!state.configured) {
		return 'unconfigured';
	}
	if (state.status === 'connecting' || state.status === 'authenticating') {
		return 'connecting';
	}
	if (state.status === 'ready'
		|| state.status === 'capturing'
		|| state.status === 'stopping') {
		return 'connected';
	}
	if (state.status === 'error') {
		return state.errorCode === 'protocol-incompatible'
			? 'incompatible'
			: 'failed';
	}
	return 'disconnected';
}

export function createBrowserAudioCompanionWebSocketFactory(): AudioCompanionWebSocketFactory {
	return (endpoint) => {
		const nativeSocket = new WebSocket(endpoint);
		nativeSocket.binaryType = 'arraybuffer';
		const adapter: AudioCompanionSocket = {
			get readyState() {
				return nativeSocket.readyState;
			},
			onOpen: null,
			onMessage: null,
			onError: null,
			onClose: null,
			send(data) {
				nativeSocket.send(data);
			},
			close(code, reason) {
				nativeSocket.close(code, reason);
			},
		};
		nativeSocket.addEventListener('open', () => adapter.onOpen?.());
		nativeSocket.addEventListener('message', (event) => adapter.onMessage?.(event.data));
		nativeSocket.addEventListener('error', (event) => adapter.onError?.(event.type));
		nativeSocket.addEventListener('close', (event) => adapter.onClose?.({
			code: event.code,
			wasClean: event.wasClean,
		}));
		return adapter;
	};
}

function createBrowserScheduler(): AudioCompanionScheduler {
	return {
		now: () => Date.now(),
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
		setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
		clearInterval: (handle) => window.clearInterval(handle as number),
	};
}

function createInitialState(configured: boolean): AudioCompanionClientState {
	return {
		status: 'idle',
		configured,
		errorCode: null,
		helperVersion: null,
		platform: null,
		supportedSources: [],
	};
}

function cloneState(state: AudioCompanionClientState): AudioCompanionClientState {
	return { ...state, supportedSources: [...state.supportedSources] };
}

function isConnectionActive(status: AudioCompanionClientStatus): boolean {
	return status === 'connecting'
		|| status === 'authenticating'
		|| status === 'ready'
		|| status === 'capturing'
		|| status === 'stopping';
}

function isValidSessionContext(
	context: AudioCompanionSessionContext | null,
): context is AudioCompanionSessionContext {
	return Boolean(context
		&& /^[A-Za-z0-9._-]{1,128}$/.test(context.sessionId)
		&& Number.isSafeInteger(context.startedAtUnixMs)
		&& context.startedAtUnixMs >= 0);
}

function audioCompanionErrorMessage(code: AudioCompanionErrorCode): string {
	const messages: Record<AudioCompanionErrorCode, string> = {
		'not-configured': 'The local audio helper is not configured.',
		'invalid-endpoint': 'The local audio helper endpoint is invalid.',
		'token-missing': 'A valid temporary pairing token is required.',
		'session-unavailable': 'The classroom session is unavailable.',
		busy: 'The local audio helper client is busy.',
		'connect-failed': 'The local audio helper connection failed.',
		'connect-timeout': 'The local audio helper connection timed out.',
		'auth-timeout': 'The local audio helper authentication timed out.',
		'auth-failed': 'The local audio helper rejected authentication.',
		'protocol-incompatible': 'The local audio helper protocol is incompatible.',
		'protocol-error': 'The local audio helper sent an invalid message.',
		'heartbeat-timeout': 'The local audio helper heartbeat timed out.',
		'stop-timeout': 'The local audio helper did not stop in time.',
		'unexpected-disconnect': 'The local audio helper disconnected unexpectedly.',
		disposed: 'The local audio helper client has been disposed.',
		'remote-error': 'The local audio helper reported an error.',
	};
	return messages[code];
}

function safeErrorName(error: unknown): string {
	return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
		? error.name
		: 'UnknownError';
}

function sanitizeDiagnosticType(type: string): string {
	return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(type) ? type : 'UnknownError';
}
