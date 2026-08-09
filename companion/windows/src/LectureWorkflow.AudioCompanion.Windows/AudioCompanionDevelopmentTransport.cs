using System.Net.WebSockets;

namespace LectureWorkflow.AudioCompanion.Windows;

internal interface IAudioCompanionDevelopmentTransport : IAsyncDisposable
{
    WebSocketState State { get; }

    ValueTask ConnectAsync(Uri endpoint, CancellationToken cancellationToken);

    ValueTask<WebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken cancellationToken);

    ValueTask SendAsync(
        ReadOnlyMemory<byte> buffer,
        WebSocketMessageType messageType,
        CancellationToken cancellationToken);

    ValueTask CloseAsync(
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken);
}

internal sealed class ClientWebSocketDevelopmentTransport : IAudioCompanionDevelopmentTransport
{
    private readonly ClientWebSocket socket = new();

    public WebSocketState State => socket.State;

    public async ValueTask ConnectAsync(Uri endpoint, CancellationToken cancellationToken) =>
        await socket.ConnectAsync(endpoint, cancellationToken).ConfigureAwait(false);

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
        CancellationToken cancellationToken) =>
        new(socket.CloseAsync(status, description, cancellationToken));

    public ValueTask DisposeAsync()
    {
        socket.Dispose();
        return ValueTask.CompletedTask;
    }
}
