using System.Buffers.Binary;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using LectureWorkflow.AudioCompanion.Protocol;

namespace LectureWorkflow.AudioCompanion.Windows;

public static class AudioCompanionDevelopmentClient
{
    private static readonly Uri Endpoint = new("ws://127.0.0.1:43127/v1/audio");

    public static async Task<int> RunAsync(
        string token,
        TextWriter output,
        TextWriter error,
        TimeSpan? runDuration = null)
    {
        ArgumentNullException.ThrowIfNull(token);
        using CancellationTokenSource cancellation = new();
        ConsoleCancelEventHandler handler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += handler;
        await using IAudioCompanionDevelopmentTransport client = new ClientWebSocketDevelopmentTransport();
        try
        {
            return await RunCoreAsync(token, output, error, client, cancellation, runDuration).ConfigureAwait(false);
        }
        finally
        {
            Console.CancelKeyPress -= handler;
        }
    }

    internal static async Task<int> RunCoreAsync(
        string token,
        TextWriter output,
        TextWriter error,
        IAudioCompanionDevelopmentTransport client,
        CancellationTokenSource cancellation,
        TimeSpan? runDuration = null)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(error);
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(cancellation);
        string sessionId = $"manual-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss-fff}";
        uint? previousSequence = null;
        ulong previousOffset = 0;
        long frameCount = 0;
        try
        {
            await client.ConnectAsync(Endpoint, cancellation.Token).ConfigureAwait(false);
            await SendJsonAsync(client, new
            {
                type = "HELLO",
                protocolVersion = 1,
                sessionId,
                clientVersion = "1.0.0-dev",
                auth = new { scheme = "pairing-token", token },
            }, cancellation.Token).ConfigureAwait(false);
            token = string.Empty;
            await ExpectAsync(client, "READY", null, cancellation.Token).ConfigureAwait(false);
            await SendJsonAsync(client, new
            {
                type = "START",
                protocolVersion = 1,
                sessionId,
                sourceId = AudioCompanionProtocol.SourceId,
                format = new { sampleFormat = "s16le", sampleRate = 16000, channels = 1 },
                sessionStartedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                captureStartOffsetMs = 0,
            }, cancellation.Token).ConfigureAwait(false);
            await ExpectAsync(client, "STATUS", "capturing", cancellation.Token).ConfigureAwait(false);
            if (runDuration.HasValue)
            {
                cancellation.CancelAfter(runDuration.Value);
            }

            output.WriteLine("客户端状态：正在接收系统音频；按 Ctrl+C 停止");

            while (!cancellation.IsCancellationRequested)
            {
                ReceivedMessage message = await ReceiveAsync(client, cancellation.Token).ConfigureAwait(false);
                try
                {
                    if (message.Type == WebSocketMessageType.Text)
                    {
                        await HandleControlAsync(client, message.Bytes, cancellation.Token).ConfigureAwait(false);
                        continue;
                    }

                    AudioFrameHeader header = AudioCompanionProtocol.DecodeFrameHeader(message.Bytes);
                    if ((previousSequence.HasValue && header.Sequence <= previousSequence.Value)
                        || (previousSequence.HasValue && header.OffsetMs < previousOffset))
                    {
                        throw new InvalidOperationException("Frame ordering failed.");
                    }

                    previousSequence = header.Sequence;
                    previousOffset = header.OffsetMs;
                    frameCount++;
                    if (frameCount % 50 == 0)
                    {
                        output.WriteLine($"客户端状态：接收中；帧数：{frameCount}；RMS：{CalculateRms(message.Bytes):P0}");
                    }
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(message.Bytes);
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        catch (AudioCompanionRemoteErrorException exception)
        {
            error.WriteLine($"客户端状态：失败；错误码：{exception.Code}");
            return 1;
        }
        catch
        {
            error.WriteLine("客户端状态：失败；错误码：test-client-failed");
            return 1;
        }
        finally
        {
            token = string.Empty;
        }

        if (client.State == WebSocketState.Open)
        {
            try
            {
                using CancellationTokenSource stopTimeout = new(TimeSpan.FromSeconds(3));
                await SendJsonAsync(client, new
                {
                    type = "STOP",
                    protocolVersion = 1,
                    sessionId,
                }, stopTimeout.Token).ConfigureAwait(false);
                await ExpectAsync(client, "STATUS", "stopped", stopTimeout.Token).ConfigureAwait(false);
                await client.CloseAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "test-complete",
                    stopTimeout.Token).ConfigureAwait(false);
            }
            catch (AudioCompanionRemoteErrorException exception)
            {
                error.WriteLine($"客户端状态：停止失败；错误码：{exception.Code}");
                return 1;
            }
            catch
            {
                error.WriteLine("客户端状态：停止确认失败；错误码：test-client-stop-failed");
                return 1;
            }
        }

        output.WriteLine($"客户端状态：已停止；接收帧数：{frameCount}");
        return 0;
    }

    private static async Task ExpectAsync(
        IAudioCompanionDevelopmentTransport client,
        string expectedType,
        string? expectedStatus,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            ReceivedMessage message = await ReceiveAsync(client, cancellationToken).ConfigureAwait(false);
            try
            {
                if (message.Type != WebSocketMessageType.Text)
                {
                    throw new InvalidOperationException("Expected control message.");
                }

                ServerControlMessage control = ParseServerControl(message.Bytes);
                if (control.Type == "PING")
                {
                    await ReplyPongAsync(client, control.Id, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                if (control.Type != expectedType
                    || (expectedStatus is not null && control.Status != expectedStatus))
                {
                    throw new InvalidOperationException("Unexpected control message.");
                }

                return;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(message.Bytes);
            }
        }
    }

    private static async Task HandleControlAsync(
        IAudioCompanionDevelopmentTransport client,
        byte[] bytes,
        CancellationToken cancellationToken)
    {
        ServerControlMessage control = ParseServerControl(bytes);
        if (control.Type == "PING")
        {
            await ReplyPongAsync(client, control.Id, cancellationToken).ConfigureAwait(false);
            return;
        }

        throw new InvalidOperationException("Unexpected control message.");
    }

    private static ServerControlMessage ParseServerControl(ReadOnlyMemory<byte> bytes)
    {
        using JsonDocument document = JsonDocument.Parse(bytes);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("protocolVersion", out JsonElement version)
            || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out int protocolVersion)
            || protocolVersion != AudioCompanionProtocol.Version
            || !root.TryGetProperty("type", out JsonElement typeElement)
            || typeElement.ValueKind != JsonValueKind.String)
        {
            throw new InvalidOperationException("Invalid server control message.");
        }

        string type = typeElement.GetString()!;
        if (type == "ERROR")
        {
            if (!root.TryGetProperty("code", out JsonElement codeElement)
                || codeElement.ValueKind != JsonValueKind.String
                || !IsStableRemoteErrorCode(codeElement.GetString()))
            {
                throw new InvalidOperationException("Invalid server error message.");
            }

            throw new AudioCompanionRemoteErrorException(codeElement.GetString()!);
        }

        string? status = null;
        long id = 0;
        if (type == "STATUS")
        {
            if (!root.TryGetProperty("status", out JsonElement statusElement)
                || statusElement.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException("Invalid status message.");
            }

            status = statusElement.GetString();
        }
        else if (type == "PING")
        {
            if (!root.TryGetProperty("id", out JsonElement idElement)
                || idElement.ValueKind != JsonValueKind.Number
                || !idElement.TryGetInt64(out id))
            {
                throw new InvalidOperationException("Invalid heartbeat message.");
            }
        }

        return new ServerControlMessage(type, status, id);
    }

    private static bool IsStableRemoteErrorCode(string? code) => code is
        "AUTH_FAILED"
        or "PROTOCOL_MISMATCH"
        or "INVALID_REQUEST"
        or "SOURCE_UNAVAILABLE"
        or "FORMAT_UNSUPPORTED"
        or "CAPTURE_FAILED"
        or "BUSY"
        or "INTERNAL_ERROR";

    private static Task ReplyPongAsync(
        IAudioCompanionDevelopmentTransport client,
        long id,
        CancellationToken cancellationToken) => SendJsonAsync(client, new
        {
            type = "PONG",
            protocolVersion = 1,
            id,
        }, cancellationToken);

    private static async Task SendJsonAsync<T>(
        IAudioCompanionDevelopmentTransport client,
        T value,
        CancellationToken cancellationToken)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            await client.SendAsync(bytes, WebSocketMessageType.Text, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static async Task<ReceivedMessage> ReceiveAsync(
        IAudioCompanionDevelopmentTransport client,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[AudioCompanionProtocol.MaxPcmBytes + AudioCompanionProtocol.FrameHeaderBytes];
        WebSocketReceiveResult result = await client.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (!result.EndOfMessage || result.MessageType == WebSocketMessageType.Close)
        {
            CryptographicOperations.ZeroMemory(buffer);
            throw new InvalidOperationException("Incomplete or closed WebSocket message.");
        }

        byte[] exact = buffer[..result.Count];
        CryptographicOperations.ZeroMemory(buffer);
        return new ReceivedMessage(result.MessageType, exact);
    }

    private static double CalculateRms(ReadOnlySpan<byte> packet)
    {
        ReadOnlySpan<byte> pcm = packet[AudioCompanionProtocol.FrameHeaderBytes..];
        double sumSquares = 0;
        for (int index = 0; index < pcm.Length; index += sizeof(short))
        {
            double sample = BinaryPrimitives.ReadInt16LittleEndian(pcm[index..]) / 32768d;
            sumSquares += sample * sample;
        }

        return Math.Sqrt(sumSquares / (pcm.Length / sizeof(short)));
    }

    private sealed record ReceivedMessage(WebSocketMessageType Type, byte[] Bytes);

    private sealed record ServerControlMessage(string Type, string? Status, long Id);
}

internal sealed class AudioCompanionRemoteErrorException(string code)
    : Exception("The audio companion server reported a safe protocol error.")
{
    public string Code { get; } = code;
}
