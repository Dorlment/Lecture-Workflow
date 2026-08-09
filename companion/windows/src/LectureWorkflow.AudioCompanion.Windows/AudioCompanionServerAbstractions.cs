using System.Net.WebSockets;
using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Windows;

public interface IAudioCompanionSocket : IAsyncDisposable
{
    WebSocketState State { get; }

    ValueTask<WebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken cancellationToken);

    ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, CancellationToken cancellationToken);

    ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken);
}

public sealed class SystemAudioCompanionSocket(WebSocket socket) : IAudioCompanionSocket
{
    private readonly WebSocket socket = socket ?? throw new ArgumentNullException(nameof(socket));

    public WebSocketState State => socket.State;

    public async ValueTask<WebSocketReceiveResult> ReceiveAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken)
    {
        ValueWebSocketReceiveResult result = await socket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
        return new WebSocketReceiveResult(result.Count, result.MessageType, result.EndOfMessage);
    }

    public ValueTask SendAsync(
        ReadOnlyMemory<byte> buffer,
        WebSocketMessageType messageType,
        CancellationToken cancellationToken) =>
        socket.SendAsync(buffer, messageType, endOfMessage: true, cancellationToken);

    public ValueTask CloseAsync(
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken) => new(socket.CloseAsync(status, description, cancellationToken));

    public ValueTask DisposeAsync()
    {
        socket.Dispose();
        return ValueTask.CompletedTask;
    }
}

public interface IAudioServerCapture : IAsyncDisposable
{
    Task Completion { get; }

    AudioProbeErrorCode? ErrorCode { get; }

    Task StartAsync(CancellationToken cancellationToken);

    Task StopAsync();
}

public interface IAudioServerCaptureFactory
{
    IAudioServerCapture Create(IAudioFrameSink sink);
}

public sealed class WasapiServerCaptureFactory : IAudioServerCaptureFactory
{
    public IAudioServerCapture Create(IAudioFrameSink sink) => new AudioProbeServerCapture(sink);
}

internal sealed class AudioProbeServerCapture : IAudioServerCapture
{
    private readonly ServerProbeReporter reporter = new();
    private readonly AudioProbeSession session;

    public AudioProbeServerCapture(IAudioFrameSink sink)
    {
        session = new AudioProbeSession(
            new WasapiLoopbackCaptureBackendFactory(),
            reporter,
            frameSink: sink);
    }

    public Task Completion => session.Completion;

    public AudioProbeErrorCode? ErrorCode => reporter.ErrorCode;

    public Task StartAsync(CancellationToken cancellationToken) => session.StartAsync(cancellationToken);

    public Task StopAsync() => session.StopAsync();

    public ValueTask DisposeAsync() => session.DisposeAsync();

    private sealed class ServerProbeReporter : IProbeReporter
    {
        public AudioProbeErrorCode? ErrorCode { get; private set; }

        public void ReportStarting()
        {
        }

        public void ReportCapturing(AudioInputFormat format)
        {
        }

        public void ReportFrame(long frameCount, double rms)
        {
        }

        public void ReportStopping()
        {
        }

        public void ReportStopped(long frameCount)
        {
        }

        public void ReportError(AudioProbeErrorCode errorCode) => ErrorCode = errorCode;
    }
}

public sealed class ExclusiveLease
{
    private int held;

    public IDisposable? TryAcquire()
    {
        return Interlocked.CompareExchange(ref held, 1, 0) == 0
            ? new Lease(this)
            : null;
    }

    public bool IsHeld => Volatile.Read(ref held) != 0;

    private sealed class Lease(ExclusiveLease owner) : IDisposable
    {
        private ExclusiveLease? owner = owner;

        public void Dispose()
        {
            ExclusiveLease? active = Interlocked.Exchange(ref owner, null);
            if (active is not null)
            {
                Volatile.Write(ref active.held, 0);
            }
        }
    }
}
