using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Threading.Channels;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class BoundedWebSocketSender : IAsyncDisposable
{
    public const int AudioCapacity = 100;
    public const int ControlCapacity = 16;
    public const int ControlByteCapacity = 32 * 1024;

    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(2);
    private readonly IAudioCompanionSocket socket;
    private readonly Channel<OutboundMessage> controls;
    private readonly Channel<OutboundMessage> audio;
    private readonly CancellationTokenSource cancellation = new();
    private readonly SemaphoreSlim available = new(0);
    private readonly Task sendLoop;
    private readonly Action<string>? onFatalError;
    private long queuedControlBytes;
    private int disposed;

    public BoundedWebSocketSender(IAudioCompanionSocket socket, Action<string>? onFatalError = null)
    {
        this.socket = socket ?? throw new ArgumentNullException(nameof(socket));
        this.onFatalError = onFatalError;
        controls = CreateChannel(ControlCapacity);
        audio = CreateChannel(AudioCapacity);
        sendLoop = SendLoopAsync();
    }

    public Task Completion => sendLoop;

    public Task SendControlAsync(byte[] message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);
        OutboundMessage outbound = new(message, WebSocketMessageType.Text, isSensitive: false);
        long totalBytes = Interlocked.Add(ref queuedControlBytes, message.Length);
        if (totalBytes > ControlByteCapacity || !controls.Writer.TryWrite(outbound))
        {
            Interlocked.Add(ref queuedControlBytes, -message.Length);
            outbound.Dispose();
            throw new AudioServerException("control-backpressure");
        }

        available.Release();
        return outbound.WaitAsync(cancellationToken);
    }

    public bool TrySendAudio(byte[] packet)
    {
        ArgumentNullException.ThrowIfNull(packet);
        if (Volatile.Read(ref disposed) != 0)
        {
            CryptographicOperations.ZeroMemory(packet);
            return false;
        }

        OutboundMessage outbound = new(packet, WebSocketMessageType.Binary, isSensitive: true);
        if (!audio.Writer.TryWrite(outbound))
        {
            outbound.Dispose();
            return false;
        }

        available.Release();
        return true;
    }

    public void ClearAudio()
    {
        while (audio.Reader.TryRead(out OutboundMessage? message))
        {
            message.Dispose();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        controls.Writer.TryComplete();
        audio.Writer.TryComplete();
        cancellation.Cancel();
        available.Release();
        try
        {
            await sendLoop.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            Drain(controls.Reader, isControl: true);
            Drain(audio.Reader, isControl: false);
            available.Dispose();
            cancellation.Dispose();
        }
    }

    private async Task SendLoopAsync()
    {
        while (!cancellation.IsCancellationRequested)
        {
            await available.WaitAsync(cancellation.Token).ConfigureAwait(false);
            OutboundMessage? message = null;
            if (!controls.Reader.TryRead(out message))
            {
                audio.Reader.TryRead(out message);
            }
            else
            {
                Interlocked.Add(ref queuedControlBytes, -message.Buffer.Length);
            }

            if (message is null)
            {
                continue;
            }

            using (message)
            using (CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token))
            {
                timeout.CancelAfter(SendTimeout);
                try
                {
                    await socket.SendAsync(message.Buffer, message.MessageType, timeout.Token).ConfigureAwait(false);
                    message.Complete();
                }
                catch (Exception exception)
                {
                    message.Fail(exception is OperationCanceledException
                        ? new AudioServerException("send-timeout")
                        : new AudioServerException("send-failed"));
                    cancellation.Cancel();
                    onFatalError?.Invoke(exception is OperationCanceledException ? "send-timeout" : "send-failed");
                    break;
                }
            }
        }
    }

    private static Channel<OutboundMessage> CreateChannel(int capacity) =>
        Channel.CreateBounded<OutboundMessage>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });

    private void Drain(ChannelReader<OutboundMessage> reader, bool isControl)
    {
        while (reader.TryRead(out OutboundMessage? message))
        {
            if (isControl)
            {
                Interlocked.Add(ref queuedControlBytes, -message.Buffer.Length);
            }

            message.Dispose();
        }
    }

    private sealed class OutboundMessage(byte[] buffer, WebSocketMessageType messageType, bool isSensitive) : IDisposable
    {
        private byte[]? buffer = buffer;
        private readonly bool isSensitive = isSensitive;
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ReadOnlyMemory<byte> Buffer => buffer ?? ReadOnlyMemory<byte>.Empty;

        public WebSocketMessageType MessageType { get; } = messageType;

        public Task WaitAsync(CancellationToken cancellationToken) => completion.Task.WaitAsync(cancellationToken);

        public void Complete() => completion.TrySetResult();

        public void Fail(Exception exception) => completion.TrySetException(exception);

        public void Dispose()
        {
            byte[]? active = Interlocked.Exchange(ref buffer, null);
            if (active is not null && isSensitive)
            {
                CryptographicOperations.ZeroMemory(active);
            }

            completion.TrySetCanceled();
        }
    }
}

public sealed class AudioServerException(string code) : Exception("Audio companion server operation failed.")
{
    public string Code { get; } = code;
}
