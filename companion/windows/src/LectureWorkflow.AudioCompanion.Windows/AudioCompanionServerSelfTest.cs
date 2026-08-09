using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Protocol;

namespace LectureWorkflow.AudioCompanion.Windows;

public static class AudioCompanionServerSelfTest
{
    public static async Task<int> RunAsync(TextWriter output, TextWriter error)
    {
        string? token = AudioCompanionTokenDigest.GenerateToken();
        AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(token);
        await using AudioCompanionServerHost host = new(digest, new SyntheticCaptureFactory());
        try
        {
            await host.StartAsync().ConfigureAwait(false);
            using ClientWebSocket client = new();
            await client.ConnectAsync(new Uri("ws://127.0.0.1:43127/v1/audio"), CancellationToken.None).ConfigureAwait(false);
            await SendJsonAsync(client, new
            {
                type = "HELLO",
                protocolVersion = 1,
                sessionId = "self-test-session",
                clientVersion = "1.0.0",
                auth = new { scheme = "pairing-token", token },
            }).ConfigureAwait(false);
            token = null;
            await ExpectTextTypeAsync(client, "READY").ConfigureAwait(false);

            await StartAndStopAsync(client, 12500).ConfigureAwait(false);
            await StartAndStopAsync(client, 14000).ConfigureAwait(false);
            output.WriteLine("server-self-test：通过；完成两次捕获；未使用真实音频设备");
            return 0;
        }
        catch
        {
            error.WriteLine("server-self-test：失败；错误码：self-test-failed");
            return 1;
        }
        finally
        {
            token = null;
        }
    }

    private static async Task StartAndStopAsync(ClientWebSocket client, long offsetMs)
    {
        await SendJsonAsync(client, new
        {
            type = "START",
            protocolVersion = 1,
            sessionId = "self-test-session",
            sourceId = AudioCompanionProtocol.SourceId,
            format = new { sampleFormat = "s16le", sampleRate = 16000, channels = 1 },
            sessionStartedAtUnixMs = 1_000_000,
            captureStartOffsetMs = offsetMs,
        }).ConfigureAwait(false);
        await ExpectStatusAsync(client, "capturing").ConfigureAwait(false);

        ReceivedMessage frame = await ReceiveAsync(client).ConfigureAwait(false);
        while (frame.Type == WebSocketMessageType.Text)
        {
            try
            {
                await RespondToPingAsync(client, frame.Bytes).ConfigureAwait(false);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(frame.Bytes);
            }

            frame = await ReceiveAsync(client).ConfigureAwait(false);
        }

        try
        {
            AudioFrameHeader header = AudioCompanionProtocol.DecodeFrameHeader(frame.Bytes);
            if (header.Sequence != 0 || header.OffsetMs < (ulong)offsetMs)
            {
                throw new InvalidOperationException("Unexpected synthetic frame metadata.");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(frame.Bytes);
        }

        await SendJsonAsync(client, new
        {
            type = "STOP",
            protocolVersion = 1,
            sessionId = "self-test-session",
        }).ConfigureAwait(false);
        await ExpectStatusAsync(client, "stopped").ConfigureAwait(false);
    }

    private static async Task ExpectTextTypeAsync(ClientWebSocket client, string expectedType)
    {
        ReceivedMessage message = await ReceiveAsync(client).ConfigureAwait(false);
        try
        {
            using JsonDocument document = JsonDocument.Parse(message.Bytes);
            if (message.Type != WebSocketMessageType.Text
                || document.RootElement.GetProperty("type").GetString() != expectedType)
            {
                throw new InvalidOperationException("Unexpected self-test message.");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(message.Bytes);
        }
    }

    private static async Task ExpectStatusAsync(ClientWebSocket client, string expectedStatus)
    {
        while (true)
        {
            ReceivedMessage message = await ReceiveAsync(client).ConfigureAwait(false);
            try
            {
                if (message.Type != WebSocketMessageType.Text)
                {
                    throw new InvalidOperationException("Expected a status message.");
                }

                using JsonDocument document = JsonDocument.Parse(message.Bytes);
                string? type = document.RootElement.GetProperty("type").GetString();
                if (type == "PING")
                {
                    await RespondToPingAsync(client, message.Bytes).ConfigureAwait(false);
                    continue;
                }

                if (type != "STATUS" || document.RootElement.GetProperty("status").GetString() != expectedStatus)
                {
                    throw new InvalidOperationException("Unexpected status message.");
                }

                return;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(message.Bytes);
            }
        }
    }

    private static async Task RespondToPingAsync(ClientWebSocket client, byte[] bytes)
    {
        using JsonDocument document = JsonDocument.Parse(bytes);
        if (document.RootElement.GetProperty("type").GetString() == "PING")
        {
            long id = document.RootElement.GetProperty("id").GetInt64();
            await SendJsonAsync(client, new { type = "PONG", protocolVersion = 1, id }).ConfigureAwait(false);
        }
    }

    private static Task SendJsonAsync<T>(ClientWebSocket client, T value)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        return SendAndClearAsync(client, bytes);
    }

    private static async Task SendAndClearAsync(ClientWebSocket client, byte[] bytes)
    {
        try
        {
            await client.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static async Task<ReceivedMessage> ReceiveAsync(ClientWebSocket client)
    {
        byte[] buffer = new byte[AudioCompanionProtocol.MaxPcmBytes + AudioCompanionProtocol.FrameHeaderBytes];
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(5));
        WebSocketReceiveResult result = await client.ReceiveAsync(buffer, timeout.Token).ConfigureAwait(false);
        if (!result.EndOfMessage || result.MessageType == WebSocketMessageType.Close)
        {
            throw new InvalidOperationException("Incomplete self-test message.");
        }

        byte[] exact = buffer[..result.Count];
        CryptographicOperations.ZeroMemory(buffer);
        return new ReceivedMessage(result.MessageType, exact);
    }

    private sealed record ReceivedMessage(WebSocketMessageType Type, byte[] Bytes);

    private sealed class SyntheticCaptureFactory : IAudioServerCaptureFactory
    {
        public IAudioServerCapture Create(IAudioFrameSink sink) => new SyntheticCapture(sink);
    }

    private sealed class SyntheticCapture(IAudioFrameSink sink) : IAudioServerCapture
    {
        private readonly CancellationTokenSource cancellation = new();
        private Task completion = Task.CompletedTask;

        public Task Completion => completion;

        public AudioProbeErrorCode? ErrorCode => null;

        public Task StartAsync(CancellationToken cancellationToken)
        {
            completion = EmitAsync(cancellationToken);
            return Task.CompletedTask;
        }

        public async Task StopAsync()
        {
            cancellation.Cancel();
            try
            {
                await completion.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        public async ValueTask DisposeAsync()
        {
            await StopAsync().ConfigureAwait(false);
            cancellation.Dispose();
        }

        private async Task EmitAsync(CancellationToken externalCancellation)
        {
            using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
                cancellation.Token,
                externalCancellation);
            while (!linked.IsCancellationRequested)
            {
                await Task.Delay(50, linked.Token).ConfigureAwait(false);
                byte[] pcm = new byte[AudioCompanionProtocol.BytesPerFrame];
                AudioFrame frame = new(0, 0, 0, pcm, 0);
                sink.TryAccept(frame, new AudioFrameCaptureMetadata(
                    System.Diagnostics.Stopwatch.GetTimestamp(),
                    20));
            }
        }
    }
}
