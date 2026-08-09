using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LectureWorkflow.AudioCompanion.Protocol;

public static class AudioCompanionProtocol
{
    public const int Version = 1;
    public const int MaxControlBytes = 32 * 1024;
    public const int MaxPcmBytes = 64 * 1024;
    public const int FrameHeaderBytes = 32;
    public const int SampleRate = 16_000;
    public const int Channels = 1;
    public const int BytesPerSample = 2;
    public const int SamplesPerFrame = 320;
    public const int BytesPerFrame = SamplesPerFrame * BytesPerSample;
    public const ulong MaxSafeInteger = 9_007_199_254_740_991;
    public const string SourceId = "windows-wasapi-loopback";
    public const string SampleFormat = "s16le";
    public const string HelperVersion = "1.0.0";

    private static readonly byte[] FrameMagic = "LWAF"u8.ToArray();

    public static byte[] EncodeFrame(uint sequence, ulong offsetMs, ReadOnlySpan<byte> pcm)
    {
        if (offsetMs > MaxSafeInteger)
        {
            throw new AudioCompanionProtocolException("offset-out-of-range");
        }

        if (pcm.Length == 0 || pcm.Length > MaxPcmBytes || pcm.Length % (Channels * BytesPerSample) != 0)
        {
            throw new AudioCompanionProtocolException("invalid-pcm-length");
        }

        uint sampleCount = checked((uint)(pcm.Length / (Channels * BytesPerSample)));
        byte[] packet = GC.AllocateUninitializedArray<byte>(FrameHeaderBytes + pcm.Length);
        FrameMagic.CopyTo(packet, 0);
        packet[4] = 1;
        packet[5] = 1;
        packet[6] = Channels;
        packet[7] = 0;
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(8, 4), sequence);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(12, 4), SampleRate);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(16, 4), sampleCount);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(20, 4), checked((uint)pcm.Length));
        BinaryPrimitives.WriteUInt64LittleEndian(packet.AsSpan(24, 8), offsetMs);
        pcm.CopyTo(packet.AsSpan(FrameHeaderBytes));
        return packet;
    }

    public static AudioFrameHeader DecodeFrameHeader(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < FrameHeaderBytes || !packet[..4].SequenceEqual(FrameMagic))
        {
            throw new AudioCompanionProtocolException("invalid-frame-header");
        }

        byte version = packet[4];
        byte format = packet[5];
        byte channels = packet[6];
        byte flags = packet[7];
        uint sequence = BinaryPrimitives.ReadUInt32LittleEndian(packet[8..12]);
        uint sampleRate = BinaryPrimitives.ReadUInt32LittleEndian(packet[12..16]);
        uint sampleCount = BinaryPrimitives.ReadUInt32LittleEndian(packet[16..20]);
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(packet[20..24]);
        ulong offsetMs = BinaryPrimitives.ReadUInt64LittleEndian(packet[24..32]);
        if (version != 1 || format != 1 || channels != Channels || flags != 0 || sampleRate != SampleRate)
        {
            throw new AudioCompanionProtocolException("invalid-frame-format");
        }

        if (payloadLength > MaxPcmBytes || payloadLength != packet.Length - FrameHeaderBytes)
        {
            throw new AudioCompanionProtocolException("invalid-payload-length");
        }

        ulong expectedLength = (ulong)sampleCount * channels * BytesPerSample;
        if (sampleCount == 0 || expectedLength != payloadLength || offsetMs > MaxSafeInteger)
        {
            throw new AudioCompanionProtocolException("invalid-frame-values");
        }

        return new AudioFrameHeader(sequence, sampleRate, sampleCount, payloadLength, offsetMs);
    }
}

public sealed record AudioFrameHeader(
    uint Sequence,
    uint SampleRate,
    uint SampleCount,
    uint PayloadLength,
    ulong OffsetMs);

public sealed class AudioCompanionProtocolException(string reason) : Exception("Invalid audio companion protocol message.")
{
    public string Reason { get; } = reason;
}

public enum ClientControlKind
{
    Hello,
    Start,
    Stop,
    Ping,
    Pong,
}

public abstract record ClientControlMessage(ClientControlKind Kind);

public sealed record HelloControlMessage(string SessionId, string ClientVersion, string Token)
    : ClientControlMessage(ClientControlKind.Hello);

public sealed record StartControlMessage(
    string SessionId,
    string SourceId,
    long SessionStartedAtUnixMs,
    long CaptureStartOffsetMs)
    : ClientControlMessage(ClientControlKind.Start);

public sealed record StopControlMessage(string SessionId) : ClientControlMessage(ClientControlKind.Stop);

public sealed record HeartbeatControlMessage(ClientControlKind HeartbeatKind, long Id)
    : ClientControlMessage(HeartbeatKind);

public static class AudioCompanionControlCodec
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static ClientControlMessage ParseClient(ReadOnlyMemory<byte> utf8)
    {
        if (utf8.IsEmpty || utf8.Length > AudioCompanionProtocol.MaxControlBytes)
        {
            throw new AudioCompanionProtocolException("control-message-size");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8);
            JsonElement root = document.RootElement;
            RequireObject(root);
            string type = GetRequiredString(root, "type", 1, 16);
            RequireProtocolVersion(root);
            return type switch
            {
                "HELLO" => ParseHello(root),
                "START" => ParseStart(root),
                "STOP" => ParseStop(root),
                "PING" => ParseHeartbeat(root, ClientControlKind.Ping),
                "PONG" => ParseHeartbeat(root, ClientControlKind.Pong),
                _ => throw new AudioCompanionProtocolException("unknown-message-type"),
            };
        }
        catch (AudioCompanionProtocolException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new AudioCompanionProtocolException("invalid-json") { Source = exception.GetType().Name };
        }
    }

    public static byte[] Ready() => Encode(new
    {
        type = "READY",
        protocolVersion = AudioCompanionProtocol.Version,
        helperVersion = AudioCompanionProtocol.HelperVersion,
        platform = "windows",
        supportedSources = new[] { AudioCompanionProtocol.SourceId },
        supportedFormats = new[]
        {
            new
            {
                sampleFormat = AudioCompanionProtocol.SampleFormat,
                sampleRate = AudioCompanionProtocol.SampleRate,
                channels = AudioCompanionProtocol.Channels,
            },
        },
        capabilities = new[] { "audio-frame-v1", "heartbeat-v1", "source-selection-v1" },
    });

    public static byte[] Status(string status) => Encode(new
    {
        type = "STATUS",
        protocolVersion = AudioCompanionProtocol.Version,
        status,
    });

    public static byte[] Error(string code, string messageZh, bool retryable) => Encode(new
    {
        type = "ERROR",
        protocolVersion = AudioCompanionProtocol.Version,
        code,
        messageZh,
        retryable,
    });

    public static byte[] Ping(long id) => Heartbeat("PING", id);

    public static byte[] Pong(long id) => Heartbeat("PONG", id);

    private static byte[] Heartbeat(string type, long id)
    {
        if (id < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(id));
        }

        return Encode(new { type, protocolVersion = AudioCompanionProtocol.Version, id });
    }

    private static byte[] Encode<T>(T value)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        if (bytes.Length > AudioCompanionProtocol.MaxControlBytes)
        {
            CryptographicOperations.ZeroMemory(bytes);
            throw new AudioCompanionProtocolException("control-message-size");
        }

        return bytes;
    }

    private static HelloControlMessage ParseHello(JsonElement root)
    {
        RequireExactProperties(root, "type", "protocolVersion", "sessionId", "clientVersion", "auth");
        string sessionId = GetSessionId(root);
        string clientVersion = GetRequiredString(root, "clientVersion", 1, 64);
        JsonElement auth = GetRequiredProperty(root, "auth");
        RequireObject(auth);
        RequireExactProperties(auth, "scheme", "token");
        if (GetRequiredString(auth, "scheme", 1, 32) != "pairing-token")
        {
            throw new AudioCompanionProtocolException("invalid-auth-scheme");
        }

        string token = GetRequiredString(auth, "token", 43, 256);
        if (!AudioCompanionTokenDigest.IsValidToken(token))
        {
            throw new AudioCompanionProtocolException("invalid-token-format");
        }

        return new HelloControlMessage(sessionId, clientVersion, token);
    }

    private static StartControlMessage ParseStart(JsonElement root)
    {
        RequireExactProperties(root, "type", "protocolVersion", "sessionId", "sourceId", "format", "sessionStartedAtUnixMs", "captureStartOffsetMs");
        string sessionId = GetSessionId(root);
        string source = GetRequiredString(root, "sourceId", 1, 64);
        if (source != AudioCompanionProtocol.SourceId)
        {
            throw new AudioCompanionProtocolException("unsupported-source");
        }

        JsonElement format = GetRequiredProperty(root, "format");
        RequireObject(format);
        RequireExactProperties(format, "sampleFormat", "sampleRate", "channels");
        if (GetRequiredString(format, "sampleFormat", 1, 16) != AudioCompanionProtocol.SampleFormat
            || GetRequiredSafeInteger(format, "sampleRate") != AudioCompanionProtocol.SampleRate
            || GetRequiredSafeInteger(format, "channels") != AudioCompanionProtocol.Channels)
        {
            throw new AudioCompanionProtocolException("unsupported-format");
        }

        return new StartControlMessage(
            sessionId,
            source,
            GetRequiredSafeInteger(root, "sessionStartedAtUnixMs"),
            GetRequiredSafeInteger(root, "captureStartOffsetMs"));
    }

    private static StopControlMessage ParseStop(JsonElement root)
    {
        RequireExactProperties(root, "type", "protocolVersion", "sessionId");
        return new StopControlMessage(GetSessionId(root));
    }

    private static HeartbeatControlMessage ParseHeartbeat(JsonElement root, ClientControlKind kind)
    {
        RequireExactProperties(root, "type", "protocolVersion", "id");
        return new HeartbeatControlMessage(kind, GetRequiredSafeInteger(root, "id"));
    }

    private static string GetSessionId(JsonElement root)
    {
        string value = GetRequiredString(root, "sessionId", 1, 128);
        if (value.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')))
        {
            throw new AudioCompanionProtocolException("invalid-session-id");
        }

        return value;
    }

    private static void RequireProtocolVersion(JsonElement root)
    {
        if (GetRequiredSafeInteger(root, "protocolVersion") != AudioCompanionProtocol.Version)
        {
            throw new AudioCompanionProtocolException("protocol-version");
        }
    }

    private static long GetRequiredSafeInteger(JsonElement element, string name)
    {
        JsonElement value = GetRequiredProperty(element, name);
        if (value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt64(out long result)
            || result < 0
            || (ulong)result > AudioCompanionProtocol.MaxSafeInteger)
        {
            throw new AudioCompanionProtocolException("invalid-integer");
        }

        return result;
    }

    private static string GetRequiredString(JsonElement element, string name, int minLength, int maxLength)
    {
        JsonElement value = GetRequiredProperty(element, name);
        string? result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (result is null || result.Length < minLength || result.Length > maxLength || result.Any(char.IsControl))
        {
            throw new AudioCompanionProtocolException("invalid-string");
        }

        return result;
    }

    private static JsonElement GetRequiredProperty(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value))
        {
            throw new AudioCompanionProtocolException("missing-field");
        }

        return value;
    }

    private static void RequireObject(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new AudioCompanionProtocolException("invalid-control-message");
        }
    }

    private static void RequireExactProperties(JsonElement element, params string[] expected)
    {
        HashSet<string> names = new(expected, StringComparer.Ordinal);
        int count = 0;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            count++;
            if (!names.Contains(property.Name))
            {
                throw new AudioCompanionProtocolException("unknown-field");
            }
        }

        if (count != names.Count)
        {
            throw new AudioCompanionProtocolException("missing-field");
        }
    }
}

public sealed class AudioCompanionTokenDigest : IDisposable
{
    private byte[]? expectedDigest;

    private AudioCompanionTokenDigest(byte[] digest)
    {
        expectedDigest = digest;
    }

    public static AudioCompanionTokenDigest Create(string token)
    {
        if (!IsValidToken(token))
        {
            throw new AudioCompanionProtocolException("invalid-token-format");
        }

        byte[] utf8 = Encoding.UTF8.GetBytes(token);
        try
        {
            return new AudioCompanionTokenDigest(SHA256.HashData(utf8));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(utf8);
        }
    }

    public static string GenerateToken()
    {
        Span<byte> random = stackalloc byte[32];
        RandomNumberGenerator.Fill(random);
        try
        {
            return Convert.ToBase64String(random).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        finally
        {
            CryptographicOperations.ZeroMemory(random);
        }
    }

    public static bool IsValidToken(string token)
    {
        if (token.Length is < 43 or > 256 || token.Length % 4 == 1)
        {
            return false;
        }

        int decodedByteFloor = token.Length * 6 / 8;
        return decodedByteFloor >= 32
            && token.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-');
    }

    public bool Authenticate(string candidate)
    {
        byte[]? expected = Volatile.Read(ref expectedDigest);
        if (expected is null || !IsValidToken(candidate))
        {
            return false;
        }

        byte[] utf8 = Encoding.UTF8.GetBytes(candidate);
        byte[] digest = SHA256.HashData(utf8);
        try
        {
            return CryptographicOperations.FixedTimeEquals(digest, expected);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(utf8);
            CryptographicOperations.ZeroMemory(digest);
        }
    }

    public void Dispose()
    {
        byte[]? digest = Interlocked.Exchange(ref expectedDigest, null);
        if (digest is not null)
        {
            CryptographicOperations.ZeroMemory(digest);
        }
    }
}
