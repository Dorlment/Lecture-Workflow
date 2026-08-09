using System.Net.WebSockets;
using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Protocol;

namespace LectureWorkflow.AudioCompanion.Windows;

public enum AudioCompanionConnectionState
{
    AwaitingHello,
    Ready,
    Starting,
    Capturing,
    Stopping,
    Closing,
    Closed,
}

public sealed class AudioCompanionConnection : IAsyncDisposable
{
    private static readonly TimeSpan HelloTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan CaptureStartTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CaptureStopTimeout = TimeSpan.FromMilliseconds(2500);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(2);

    private readonly IAudioCompanionSocket socket;
    private readonly AudioCompanionTokenDigest tokenDigest;
    private readonly IAudioServerCaptureFactory captureFactory;
    private readonly ExclusiveLease captureLease;
    private readonly IMonotonicClock clock;
    private readonly CancellationTokenSource connectionCancellation = new();
    private readonly TaskCompletionSource<string> fatalError = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private BoundedWebSocketSender? sender;
    private CancellationTokenSource? captureCancellation;
    private IAudioServerCapture? capture;
    private WireAudioFrameSink? frameSink;
    private IDisposable? activeCaptureLease;
    private Task? captureMonitor;
    private Task? heartbeatTask;
    private Task<ClientControlMessage>? pendingReceive;
    private TaskCompletionSource? pendingPong;
    private string? sessionId;
    private long heartbeatId;
    private int disposed;

    public AudioCompanionConnection(
        IAudioCompanionSocket socket,
        AudioCompanionTokenDigest tokenDigest,
        IAudioServerCaptureFactory captureFactory,
        ExclusiveLease captureLease,
        IMonotonicClock? clock = null)
    {
        this.socket = socket ?? throw new ArgumentNullException(nameof(socket));
        this.tokenDigest = tokenDigest ?? throw new ArgumentNullException(nameof(tokenDigest));
        this.captureFactory = captureFactory ?? throw new ArgumentNullException(nameof(captureFactory));
        this.captureLease = captureLease ?? throw new ArgumentNullException(nameof(captureLease));
        this.clock = clock ?? StopwatchMonotonicClock.Instance;
    }

    public AudioCompanionConnectionState State { get; private set; } = AudioCompanionConnectionState.AwaitingHello;

    public async Task RunAsync(CancellationToken hostCancellation)
    {
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
            hostCancellation,
            connectionCancellation.Token);
        sender = new BoundedWebSocketSender(socket, code =>
        {
            fatalError.TrySetResult(code);
        });
        string? fatalProtocolCode = null;
        try
        {
            ClientControlMessage first = await ReceiveControlAsync(HelloTimeout, linked.Token).ConfigureAwait(false);
            if (first is not HelloControlMessage hello)
            {
                throw new AudioCompanionProtocolException("hello-required");
            }

            if (!tokenDigest.Authenticate(hello.Token))
            {
                fatalProtocolCode = "AUTH_FAILED";
                throw new AudioServerException("authentication-failed");
            }

            sessionId = hello.SessionId;
            await sender.SendControlAsync(AudioCompanionControlCodec.Ready(), linked.Token).ConfigureAwait(false);
            State = AudioCompanionConnectionState.Ready;
            heartbeatTask = HeartbeatLoopAsync(linked.Token);

            while (!linked.IsCancellationRequested)
            {
                Task<ClientControlMessage> receive = ReceiveControlAsync(Timeout.InfiniteTimeSpan, linked.Token);
                pendingReceive = receive;
                Task completed = await Task.WhenAny(receive, fatalError.Task).ConfigureAwait(false);
                if (completed == fatalError.Task)
                {
                    throw new AudioServerException(await fatalError.Task.ConfigureAwait(false));
                }

                ClientControlMessage message = await receive.ConfigureAwait(false);
                pendingReceive = null;
                await HandleControlAsync(message, linked.Token).ConfigureAwait(false);
            }
        }
        catch (ClientDisconnectedException)
        {
        }
        catch (OperationCanceledException) when (hostCancellation.IsCancellationRequested)
        {
        }
        catch (OperationCanceledException)
        {
            await TrySendErrorAsync("INVALID_REQUEST").ConfigureAwait(false);
        }
        catch (AudioCompanionProtocolException exception)
        {
            fatalProtocolCode = exception.Reason switch
            {
                "protocol-version" => "PROTOCOL_MISMATCH",
                "invalid-token-format" or "invalid-auth-scheme" => "AUTH_FAILED",
                "unsupported-source" => "SOURCE_UNAVAILABLE",
                "unsupported-format" => "FORMAT_UNSUPPORTED",
                _ => "INVALID_REQUEST",
            };
            await TrySendErrorAsync(fatalProtocolCode).ConfigureAwait(false);
        }
        catch (AudioProbeException exception)
        {
            fatalProtocolCode = MapCaptureError(exception.Code);
            await TrySendErrorAsync(fatalProtocolCode).ConfigureAwait(false);
        }
        catch (AudioServerException exception)
        {
            fatalProtocolCode ??= exception.Code switch
            {
                "authentication-failed" => "AUTH_FAILED",
                "capture-busy" => "BUSY",
                "unsupported-source" => "SOURCE_UNAVAILABLE",
                "source-unavailable" => "SOURCE_UNAVAILABLE",
                "unsupported-format" => "FORMAT_UNSUPPORTED",
                "capture-failed" or "capture-stop-failed" or "send-backpressure" or "sequence-exhausted" or "offset-out-of-range" => "CAPTURE_FAILED",
                _ => "INTERNAL_ERROR",
            };
            await TrySendErrorAsync(fatalProtocolCode).ConfigureAwait(false);
        }
        catch
        {
            await TrySendErrorAsync("INTERNAL_ERROR").ConfigureAwait(false);
        }
        finally
        {
            await ConnectionTeardownAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0)
        {
            connectionCancellation.Cancel();
            await ConnectionTeardownAsync().ConfigureAwait(false);
            connectionCancellation.Dispose();
        }
    }

    private async Task HandleControlAsync(ClientControlMessage message, CancellationToken cancellationToken)
    {
        switch (message)
        {
            case StartControlMessage start:
                await StartCaptureAsync(start, cancellationToken).ConfigureAwait(false);
                break;
            case StopControlMessage stop:
                await StopCaptureAsync(stop, cancellationToken).ConfigureAwait(false);
                break;
            case HeartbeatControlMessage { Kind: ClientControlKind.Ping } ping:
                await RequireSender().SendControlAsync(AudioCompanionControlCodec.Pong(ping.Id), cancellationToken).ConfigureAwait(false);
                break;
            case HeartbeatControlMessage { Kind: ClientControlKind.Pong } pong:
                if (pong.Id != Volatile.Read(ref heartbeatId) || pendingPong is null)
                {
                    throw new AudioCompanionProtocolException("unexpected-pong");
                }

                pendingPong.TrySetResult();
                break;
            case HelloControlMessage:
                throw new AudioCompanionProtocolException("duplicate-hello");
            default:
                throw new AudioCompanionProtocolException("invalid-state-message");
        }
    }

    private async Task StartCaptureAsync(StartControlMessage start, CancellationToken cancellationToken)
    {
        if (State != AudioCompanionConnectionState.Ready)
        {
            throw new AudioCompanionProtocolException("start-invalid-state");
        }

        if (!string.Equals(start.SessionId, sessionId, StringComparison.Ordinal))
        {
            throw new AudioCompanionProtocolException("session-mismatch");
        }

        IDisposable? lease = captureLease.TryAcquire();
        if (lease is null)
        {
            throw new AudioServerException("capture-busy");
        }

        activeCaptureLease = lease;
        State = AudioCompanionConnectionState.Starting;
        long startTimestamp = clock.Timestamp;
        try
        {
            captureCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            frameSink = new WireAudioFrameSink(
                RequireSender(),
                clock,
                startTimestamp,
                checked((ulong)start.CaptureStartOffsetMs),
                code => fatalError.TrySetResult(code));
            capture = captureFactory.Create(frameSink);
            await capture.StartAsync(captureCancellation.Token)
                .WaitAsync(CaptureStartTimeout, cancellationToken)
                .ConfigureAwait(false);
            await RequireSender().SendControlAsync(
                AudioCompanionControlCodec.Status("capturing"),
                cancellationToken).ConfigureAwait(false);
            State = AudioCompanionConnectionState.Capturing;
            frameSink.Enable();
            captureMonitor = MonitorCaptureAsync(capture);
        }
        catch (Exception exception)
        {
            await CaptureTeardownAsync(sendStopped: false, CancellationToken.None).ConfigureAwait(false);
            throw exception is TimeoutException
                ? new AudioServerException("capture-failed")
                : exception;
        }
    }

    private async Task StopCaptureAsync(StopControlMessage stop, CancellationToken cancellationToken)
    {
        if (State != AudioCompanionConnectionState.Capturing
            || !string.Equals(stop.SessionId, sessionId, StringComparison.Ordinal))
        {
            throw new AudioCompanionProtocolException("stop-invalid-state");
        }

        State = AudioCompanionConnectionState.Stopping;
        await CaptureTeardownAsync(sendStopped: true, cancellationToken).ConfigureAwait(false);
    }

    private async Task CaptureTeardownAsync(bool sendStopped, CancellationToken cancellationToken)
    {
        WireAudioFrameSink? activeSink = frameSink;
        IAudioServerCapture? activeCapture = capture;
        CancellationTokenSource? activeCancellation = captureCancellation;
        IDisposable? lease = activeCaptureLease;
        Task? activeMonitor = captureMonitor;
        frameSink = null;
        capture = null;
        captureCancellation = null;
        activeCaptureLease = null;
        captureMonitor = null;

        activeSink?.Stop();
        activeCancellation?.Cancel();
        bool failed = false;
        if (activeCapture is not null)
        {
            try
            {
                await activeCapture.StopAsync().WaitAsync(CaptureStopTimeout, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                failed = true;
            }

            try
            {
                await activeCapture.DisposeAsync().AsTask()
                    .WaitAsync(CaptureStopTimeout, CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch
            {
                failed = true;
            }
        }

        RequireSender().ClearAudio();
        activeCancellation?.Dispose();
        lease?.Dispose();
        if (activeMonitor is not null)
        {
            try
            {
                await activeMonitor.WaitAsync(CaptureStopTimeout, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                failed = true;
            }
        }

        if (sendStopped)
        {
            if (failed)
            {
                throw new AudioServerException("capture-stop-failed");
            }

            await RequireSender().SendControlAsync(
                AudioCompanionControlCodec.Status("stopped"),
                cancellationToken).ConfigureAwait(false);
            State = AudioCompanionConnectionState.Ready;
        }
    }

    private async Task MonitorCaptureAsync(IAudioServerCapture activeCapture)
    {
        try
        {
            await activeCapture.Completion.ConfigureAwait(false);
            if (State == AudioCompanionConnectionState.Capturing)
            {
                fatalError.TrySetResult(MapCaptureFailure(activeCapture.ErrorCode));
            }
        }
        catch
        {
            if (State == AudioCompanionConnectionState.Capturing)
            {
                fatalError.TrySetResult("capture-failed");
            }
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(HeartbeatInterval, cancellationToken).ConfigureAwait(false);
                long id = Interlocked.Increment(ref heartbeatId);
                TaskCompletionSource pong = new(TaskCreationOptions.RunContinuationsAsynchronously);
                pendingPong = pong;
                await RequireSender().SendControlAsync(AudioCompanionControlCodec.Ping(id), cancellationToken).ConfigureAwait(false);
                await pong.Task.WaitAsync(HeartbeatTimeout, cancellationToken).ConfigureAwait(false);
                pendingPong = null;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch
        {
            fatalError.TrySetResult("heartbeat-timeout");
        }
    }

    private async Task<ClientControlMessage> ReceiveControlAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[AudioCompanionProtocol.MaxControlBytes + 1];
        int count = 0;
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout != Timeout.InfiniteTimeSpan)
        {
            linked.CancelAfter(timeout);
        }

        try
        {
            while (true)
            {
                WebSocketReceiveResult result = await socket.ReceiveAsync(buffer.AsMemory(count), linked.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    throw new ClientDisconnectedException();
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    throw new AudioCompanionProtocolException("binary-client-message");
                }

                count = checked(count + result.Count);
                if (count > AudioCompanionProtocol.MaxControlBytes)
                {
                    throw new AudioCompanionProtocolException("control-message-size");
                }

                if (result.EndOfMessage)
                {
                    return AudioCompanionControlCodec.ParseClient(buffer.AsMemory(0, count));
                }
            }
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(buffer);
        }
    }

    private async Task TrySendErrorAsync(string code)
    {
        if (sender is null)
        {
            return;
        }

        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
        try
        {
            await sender.SendControlAsync(CreateSafeError(code), timeout.Token).ConfigureAwait(false);
        }
        catch
        {
        }
    }

    private async Task ConnectionTeardownAsync()
    {
        if (State == AudioCompanionConnectionState.Closed)
        {
            return;
        }

        State = AudioCompanionConnectionState.Closing;
        connectionCancellation.Cancel();
        pendingPong?.TrySetCanceled();
        pendingPong = null;
        if (capture is not null)
        {
            await CaptureTeardownAsync(sendStopped: false, CancellationToken.None).ConfigureAwait(false);
        }

        Task? activeHeartbeat = heartbeatTask;
        heartbeatTask = null;
        if (activeHeartbeat is not null)
        {
            try
            {
                await activeHeartbeat.WaitAsync(CloseTimeout, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
            }
        }

        Task<ClientControlMessage>? activeReceive = pendingReceive;
        pendingReceive = null;
        if (activeReceive is not null)
        {
            try
            {
                await activeReceive.WaitAsync(CloseTimeout, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
            }
        }

        BoundedWebSocketSender? activeSender = Interlocked.Exchange(ref sender, null);
        if (activeSender is not null)
        {
            await activeSender.DisposeAsync().ConfigureAwait(false);
        }

        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            using CancellationTokenSource timeout = new(CloseTimeout);
            try
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "connection-closed", timeout.Token).ConfigureAwait(false);
            }
            catch
            {
            }
        }

        await socket.DisposeAsync().ConfigureAwait(false);
        sessionId = null;
        State = AudioCompanionConnectionState.Closed;
    }

    private BoundedWebSocketSender RequireSender() => sender
        ?? throw new AudioServerException("sender-unavailable");

    private static string MapCaptureError(AudioProbeErrorCode code) => code switch
    {
        AudioProbeErrorCode.DefaultDeviceUnavailable or AudioProbeErrorCode.DefaultDeviceChanged or AudioProbeErrorCode.DeviceInvalidated => "SOURCE_UNAVAILABLE",
        AudioProbeErrorCode.UnsupportedInputFormat => "FORMAT_UNSUPPORTED",
        _ => "CAPTURE_FAILED",
    };

    private static string MapCaptureFailure(AudioProbeErrorCode? code) => code switch
    {
        AudioProbeErrorCode.DefaultDeviceUnavailable or AudioProbeErrorCode.DefaultDeviceChanged or AudioProbeErrorCode.DeviceInvalidated => "source-unavailable",
        AudioProbeErrorCode.UnsupportedInputFormat => "unsupported-format",
        _ => "capture-failed",
    };

    private static byte[] CreateSafeError(string code) => code switch
    {
        "AUTH_FAILED" => AudioCompanionControlCodec.Error(code, "临时配对凭据无效。", false),
        "PROTOCOL_MISMATCH" => AudioCompanionControlCodec.Error(code, "音频助手协议版本不兼容。", false),
        "INVALID_REQUEST" => AudioCompanionControlCodec.Error(code, "音频助手收到无效请求。", false),
        "SOURCE_UNAVAILABLE" => AudioCompanionControlCodec.Error(code, "当前系统音频来源不可用。", true),
        "FORMAT_UNSUPPORTED" => AudioCompanionControlCodec.Error(code, "当前音频格式不受支持。", false),
        "CAPTURE_FAILED" => AudioCompanionControlCodec.Error(code, "系统音频捕获失败。", true),
        "BUSY" => AudioCompanionControlCodec.Error(code, "音频助手已有活动连接。", true),
        _ => AudioCompanionControlCodec.Error("INTERNAL_ERROR", "音频助手发生内部错误。", true),
    };

    private sealed class ClientDisconnectedException : Exception;
}
