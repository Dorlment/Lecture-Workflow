using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Protocol;
using LectureWorkflow.AudioCompanion.Windows;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class AudioCompanionProtocolServerTests
{
    private const string ValidToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    [TestMethod]
    public void ParsesStrictHelloAndAuthenticationFields()
    {
        ClientControlMessage parsed = Parse(new
        {
            type = "HELLO",
            protocolVersion = 1,
            sessionId = "session-1",
            clientVersion = "1.0.0",
            auth = new { scheme = "pairing-token", token = ValidToken },
        });

        HelloControlMessage hello = (HelloControlMessage)parsed;
        Assert.AreEqual("session-1", hello.SessionId);
        Assert.AreEqual(ValidToken, hello.Token);
    }

    [TestMethod]
    public void RejectsUnknownControlMessageAndFields()
    {
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(new
        {
            type = "UNKNOWN",
            protocolVersion = 1,
        }));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(new
        {
            type = "STOP",
            protocolVersion = 1,
            sessionId = "session-1",
            extra = true,
        }));
    }

    [TestMethod]
    public void RejectsProtocolMismatchAndMissingHelloToken()
    {
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(new
        {
            type = "HELLO",
            protocolVersion = 2,
            sessionId = "session-1",
            clientVersion = "1.0.0",
            auth = new { scheme = "pairing-token", token = ValidToken },
        }));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(new
        {
            type = "HELLO",
            protocolVersion = 1,
            sessionId = "session-1",
            clientVersion = "1.0.0",
            auth = new { scheme = "pairing-token" },
        }));
    }

    [TestMethod]
    public void TokenValidationMatchesTypeScriptRangeAndAlphabet()
    {
        Assert.IsTrue(AudioCompanionTokenDigest.IsValidToken(ValidToken));
        Assert.IsFalse(AudioCompanionTokenDigest.IsValidToken("A".Repeat(42)));
        Assert.IsFalse(AudioCompanionTokenDigest.IsValidToken("A".Repeat(257)));
        Assert.IsFalse(AudioCompanionTokenDigest.IsValidToken("A".Repeat(42) + "+"));
    }

    [TestMethod]
    public void ExpectedDigestSupportsMultipleConnectionsUntilHostDisposal()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);

        Assert.IsTrue(digest.Authenticate(ValidToken));
        Assert.IsFalse(digest.Authenticate("B".Repeat(43)));
        Assert.IsTrue(digest.Authenticate(ValidToken));

        digest.Dispose();
        Assert.IsFalse(digest.Authenticate(ValidToken));
    }

    [TestMethod]
    public void GeneratedTokenIsThirtyTwoByteUnpaddedBase64Url()
    {
        string token = AudioCompanionTokenDigest.GenerateToken();

        Assert.AreEqual(43, token.Length);
        Assert.IsTrue(AudioCompanionTokenDigest.IsValidToken(token));
        Assert.DoesNotContain("=", token);
    }

    [TestMethod]
    public void ParsesStrictStartStopAndHeartbeatMessages()
    {
        StartControlMessage start = (StartControlMessage)Parse(StartMessage(12500));
        Assert.AreEqual(12500L, start.CaptureStartOffsetMs);
        Assert.AreEqual(AudioCompanionProtocol.SourceId, start.SourceId);

        StopControlMessage stop = (StopControlMessage)Parse(new
        {
            type = "STOP",
            protocolVersion = 1,
            sessionId = "session-1",
        });
        Assert.AreEqual("session-1", stop.SessionId);

        HeartbeatControlMessage ping = (HeartbeatControlMessage)Parse(new
        {
            type = "PING",
            protocolVersion = 1,
            id = 9,
        });
        Assert.AreEqual(9L, ping.Id);
    }

    [TestMethod]
    public void RejectsUnsupportedSourceFormatAndUnsafeOffset()
    {
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(StartMessage(
            0,
            sourceId: "microphone-input")));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(StartMessage(
            0,
            sampleRate: 48000)));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => Parse(StartMessage(
            9_007_199_254_740_992L)));
    }

    [TestMethod]
    public void RejectsJsonBeyondThirtyTwoKibibytes()
    {
        byte[] oversized = Encoding.UTF8.GetBytes(new string('x', AudioCompanionProtocol.MaxControlBytes + 1));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() =>
            AudioCompanionControlCodec.ParseClient(oversized));
    }

    [TestMethod]
    public void ReadyAndStatusMatchTypeScriptFields()
    {
        using JsonDocument ready = JsonDocument.Parse(AudioCompanionControlCodec.Ready());
        JsonElement root = ready.RootElement;
        Assert.AreEqual("READY", root.GetProperty("type").GetString());
        Assert.AreEqual(1, root.GetProperty("protocolVersion").GetInt32());
        Assert.AreEqual("windows", root.GetProperty("platform").GetString());
        Assert.AreEqual(AudioCompanionProtocol.SourceId, root.GetProperty("supportedSources")[0].GetString());

        using JsonDocument status = JsonDocument.Parse(AudioCompanionControlCodec.Status("capturing"));
        Assert.AreEqual("capturing", status.RootElement.GetProperty("status").GetString());
    }

    [TestMethod]
    public void SharedGoldenFixtureMatchesEncodedFrame()
    {
        GoldenFrame fixture = LoadFixture();
        byte[] pcm = Convert.FromHexString(fixture.PcmHex);
        byte[] packet = AudioCompanionProtocol.EncodeFrame(fixture.Sequence, fixture.OffsetMs, pcm);

        Assert.AreEqual(fixture.PacketHex, Convert.ToHexStringLower(packet));
        AudioFrameHeader header = AudioCompanionProtocol.DecodeFrameHeader(packet);
        Assert.AreEqual(fixture.Sequence, header.Sequence);
        Assert.AreEqual(fixture.SampleCount, header.SampleCount);
        Assert.AreEqual(fixture.OffsetMs, header.OffsetMs);
    }

    [TestMethod]
    public void FrameRejectsPayloadMismatchOversizeAndUnsafeOffset()
    {
        byte[] valid = AudioCompanionProtocol.EncodeFrame(0, 0, new byte[640]);
        valid[20] = 1;
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() => AudioCompanionProtocol.DecodeFrameHeader(valid));

        Assert.ThrowsExactly<AudioCompanionProtocolException>(() =>
            AudioCompanionProtocol.EncodeFrame(0, 0, new byte[AudioCompanionProtocol.MaxPcmBytes + 2]));
        Assert.ThrowsExactly<AudioCompanionProtocolException>(() =>
            AudioCompanionProtocol.EncodeFrame(0, AudioCompanionProtocol.MaxSafeInteger + 1, new byte[640]));
    }

    [TestMethod]
    public void ExclusiveLeaseAllowsOnlyOneOwnerAndCanBeReused()
    {
        ExclusiveLease lease = new();
        IDisposable first = lease.TryAcquire()!;
        Assert.IsNull(lease.TryAcquire());
        first.Dispose();
        Assert.IsNotNull(lease.TryAcquire());
    }

    [TestMethod]
    public async Task SenderSerializesControlAndAudioAndClearsAudioOnDispose()
    {
        FakeSocket socket = new();
        await using BoundedWebSocketSender sender = new(socket);
        await sender.SendControlAsync(AudioCompanionControlCodec.Status("ready"), CancellationToken.None);
        byte[] pcm = new byte[640];
        byte[] packet = AudioCompanionProtocol.EncodeFrame(0, 0, pcm);
        Assert.IsTrue(sender.TrySendAudio(packet));
        await WaitUntilAsync(() => socket.Sent.Count == 2);

        Assert.AreEqual(WebSocketMessageType.Text, socket.Sent[0].Type);
        Assert.AreEqual(WebSocketMessageType.Binary, socket.Sent[1].Type);
    }

    [TestMethod]
    public async Task WireSinkDoesNotSendBeforeCapturingAndUsesCaptureTime()
    {
        FakeSocket socket = new();
        FakeClock clock = new() { Timestamp = 1000, Frequency = 1000 };
        await using BoundedWebSocketSender sender = new(socket);
        WireAudioFrameSink sink = new(sender, clock, 1000, 500, _ => Assert.Fail("Unexpected fatal error."));

        Assert.IsFalse(sink.TryAccept(Frame(), new AudioFrameCaptureMetadata(1000, 20)));
        sink.Enable();
        Assert.IsTrue(sink.TryAccept(Frame(), new AudioFrameCaptureMetadata(1000, 20)));
        Assert.IsTrue(sink.TryAccept(Frame(), new AudioFrameCaptureMetadata(1200, 20)));
        await WaitUntilAsync(() => socket.Sent.Count == 2);

        AudioFrameHeader first = AudioCompanionProtocol.DecodeFrameHeader(socket.Sent[0].Bytes);
        AudioFrameHeader second = AudioCompanionProtocol.DecodeFrameHeader(socket.Sent[1].Bytes);
        Assert.AreEqual(0U, first.Sequence);
        Assert.AreEqual(1U, second.Sequence);
        Assert.AreEqual(500UL, first.OffsetMs);
        Assert.AreEqual(700UL, second.OffsetMs);
    }

    [TestMethod]
    public async Task NormalStopKeepsConnectionAndSecondStartResetsSequence()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        FakeCaptureFactory captures = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            captures,
            new ExclusiveLease(),
            new FakeClock { Timestamp = 1000, Frequency = 1000 });
        using CancellationTokenSource host = new();
        Task run = connection.RunAsync(host.Token);

        socket.QueueText(HelloMessage());
        socket.QueueText(StartMessage(100));
        socket.QueueText(StopMessage());
        socket.QueueText(StartMessage(200));
        socket.QueueText(StopMessage());
        await WaitUntilAsync(() => socket.SentTextTypes().Count(type => type.StartsWith("STATUS:", StringComparison.Ordinal)) == 4);
        host.Cancel();
        await run;

        CollectionAssert.AreEqual(
            new[] { "READY", "STATUS:capturing", "STATUS:stopped", "STATUS:capturing", "STATUS:stopped" },
            socket.SentTextTypes().ToArray());
        Assert.AreEqual(2, captures.Created);
        Assert.AreEqual(AudioCompanionConnectionState.Closed, connection.State);
    }

    [TestMethod]
    public async Task WrongTokenReturnsSafeErrorWithoutEchoingCredential()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            new FakeCaptureFactory(),
            new ExclusiveLease());
        socket.QueueText(HelloMessage("B".Repeat(43)));

        await connection.RunAsync(CancellationToken.None);

        string output = Encoding.UTF8.GetString(socket.Sent.Single().Bytes);
        Assert.Contains("AUTH_FAILED", output);
        Assert.DoesNotContain(ValidToken, output);
        Assert.DoesNotContain("BBBB", output);
    }

    [TestMethod]
    public async Task BinaryBeforeHelloIsRejectedAsAProtocolError()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            new FakeCaptureFactory(),
            new ExclusiveLease());
        socket.QueueBinary(new byte[640]);

        await connection.RunAsync(CancellationToken.None);

        string output = Encoding.UTF8.GetString(socket.Sent.Single().Bytes);
        Assert.Contains("INVALID_REQUEST", output);
    }

    [TestMethod]
    public async Task CaptureFactoryFailureReleasesLeaseAndClosesConnection()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        ExclusiveLease captureLease = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            new ThrowingCaptureFactory(),
            captureLease);
        socket.QueueText(HelloMessage());
        socket.QueueText(StartMessage(0));

        await connection.RunAsync(CancellationToken.None);

        using IDisposable? recovered = captureLease.TryAcquire();
        Assert.IsNotNull(recovered);
        Assert.Contains("CAPTURE_FAILED", Encoding.UTF8.GetString(socket.Sent.Last().Bytes));
    }

    [TestMethod]
    public async Task FrameProducedDuringStartupCannotPrecedeCapturingStatus()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        EarlyFrameCaptureFactory captures = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            captures,
            new ExclusiveLease(),
            new FakeClock { Timestamp = 1000, Frequency = 1000 });
        using CancellationTokenSource host = new();
        Task run = connection.RunAsync(host.Token);
        socket.QueueText(HelloMessage());
        socket.QueueText(StartMessage(0));
        await WaitUntilAsync(() => socket.SentTextTypes().Contains("STATUS:capturing"));
        host.Cancel();
        await run;

        Assert.IsFalse(socket.Sent.Any(item => item.Type == WebSocketMessageType.Binary));
    }

    [TestMethod]
    public async Task HostStopClearsExpectedTokenDigest()
    {
        AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        await using AudioCompanionServerHost host = new(digest, new FakeCaptureFactory());

        await host.StopAsync();

        Assert.IsFalse(digest.Authenticate(ValidToken));
    }

    [TestMethod]
    public async Task ConnectionTeardownAwaitsBackgroundWorkAndRejectsLateFrames()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new();
        TrackingCaptureFactory captures = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            captures,
            new ExclusiveLease(),
            new FakeClock { Timestamp = 1000, Frequency = 1000 });
        using CancellationTokenSource host = new();
        Task run = connection.RunAsync(host.Token);
        socket.QueueText(HelloMessage());
        socket.QueueText(StartMessage(0));
        await WaitUntilAsync(() => connection.State == AudioCompanionConnectionState.Capturing);

        host.Cancel();
        await run;
        int sentAtClose = socket.Sent.Count;
        AudioFrame lateFrame = Frame();

        Assert.IsFalse(captures.Sink!.TryAccept(lateFrame, new AudioFrameCaptureMetadata(2000, 20)));
        Array.Clear(lateFrame.Pcm);
        await Task.Delay(25);
        Assert.HasCount(sentAtClose, socket.Sent);
        Assert.AreEqual(1, captures.Capture!.StopCount);
        Assert.AreEqual(1, captures.Capture.DisposeCount);
        Assert.AreEqual(1, socket.DisposeCount);
        Assert.AreEqual(AudioCompanionConnectionState.Closed, connection.State);
    }

    [TestMethod]
    public async Task DefaultDeviceChangeSendsSourceUnavailableBeforeCloseAndAllowsAnotherConnection()
    {
        using AudioCompanionTokenDigest digest = AudioCompanionTokenDigest.Create(ValidToken);
        FakeSocket socket = new() { BlockErrorSend = true };
        FaultingCaptureFactory captures = new();
        ExclusiveLease captureLease = new();
        await using AudioCompanionConnection connection = new(
            socket,
            digest,
            captures,
            captureLease,
            new FakeClock { Timestamp = 1000, Frequency = 1000 });
        Task run = connection.RunAsync(CancellationToken.None);
        socket.QueueText(HelloMessage());
        socket.QueueText(StartMessage(0));
        await WaitUntilAsync(() => connection.State == AudioCompanionConnectionState.Capturing);

        captures.Capture.Fail(AudioProbeErrorCode.DefaultDeviceChanged);
        await socket.ErrorSendStarted.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.AreEqual(0, socket.CloseCount);
        Assert.AreEqual(0, captures.Capture.StopCount);
        socket.ReleaseErrorSend();
        await run.WaitAsync(TimeSpan.FromSeconds(3));

        string[] messages = socket.SentTextTypes().ToArray();
        Assert.AreEqual(1, messages.Count(message => message == "ERROR:SOURCE_UNAVAILABLE"));
        Assert.IsFalse(messages.Any(message => message == "STATUS:error"));
        Assert.IsLessThan(
            socket.Lifecycle.IndexOf("CLOSE"),
            socket.Lifecycle.IndexOf("ERROR:SOURCE_UNAVAILABLE"));
        Assert.AreEqual(1, captures.Capture.StopCount);
        Assert.AreEqual(1, captures.Capture.DisposeCount);
        using (IDisposable? recovered = captureLease.TryAcquire())
        {
            Assert.IsNotNull(recovered);
        }

        FakeSocket secondSocket = new();
        await using AudioCompanionConnection secondConnection = new(
            secondSocket,
            digest,
            new FakeCaptureFactory(),
            captureLease);
        using CancellationTokenSource secondHost = new();
        Task secondRun = secondConnection.RunAsync(secondHost.Token);
        secondSocket.QueueText(HelloMessage());
        await WaitUntilAsync(() => secondSocket.SentTextTypes().Contains("READY"));
        secondHost.Cancel();
        await secondRun.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Contains("READY", secondSocket.SentTextTypes());
    }

    [TestMethod]
    public async Task DevelopmentClientPreservesSafeRemoteErrorWithoutSensitiveMessageFields()
    {
        await using FakeDevelopmentTransport transport = new();
        transport.QueueText(new
        {
            type = "READY",
            protocolVersion = 1,
        });
        transport.QueueText(new
        {
            type = "STATUS",
            protocolVersion = 1,
            status = "capturing",
        });
        transport.QueueText(new
        {
            type = "ERROR",
            protocolVersion = 1,
            code = "SOURCE_UNAVAILABLE",
            messageZh = $"device=Secret Headphones; deviceId=secret-device-id; token={ValidToken}; data:audio/wav;base64,UENN",
            retryable = true,
        });
        using CancellationTokenSource cancellation = new();
        StringWriter output = new();
        StringWriter error = new();

        int result = await AudioCompanionDevelopmentClient.RunCoreAsync(
            ValidToken,
            output,
            error,
            transport,
            cancellation);

        Assert.AreEqual(1, result);
        Assert.Contains("SOURCE_UNAVAILABLE", error.ToString());
        Assert.DoesNotContain("test-client-failed", error.ToString());
        Assert.DoesNotContain("Secret Headphones", error.ToString());
        Assert.DoesNotContain("secret-device-id", error.ToString());
        Assert.DoesNotContain(ValidToken, error.ToString());
        Assert.DoesNotContain("data:audio", error.ToString());
        Assert.DoesNotContain("UENN", error.ToString());
    }

    [TestMethod]
    public async Task DevelopmentClientUsesGenericFailureForUnknownRemoteError()
    {
        await using FakeDevelopmentTransport transport = new();
        transport.QueueText(new { type = "READY", protocolVersion = 1 });
        transport.QueueText(new { type = "STATUS", protocolVersion = 1, status = "capturing" });
        transport.QueueText(new
        {
            type = "ERROR",
            protocolVersion = 1,
            code = "UNRECOGNIZED_REMOTE_CODE",
            messageZh = "must-not-be-printed",
            retryable = false,
        });
        using CancellationTokenSource cancellation = new();
        StringWriter error = new();

        int result = await AudioCompanionDevelopmentClient.RunCoreAsync(
            ValidToken,
            TextWriter.Null,
            error,
            transport,
            cancellation);

        Assert.AreEqual(1, result);
        Assert.Contains("test-client-failed", error.ToString());
        Assert.DoesNotContain("UNRECOGNIZED_REMOTE_CODE", error.ToString());
        Assert.DoesNotContain("must-not-be-printed", error.ToString());
    }

    [TestMethod]
    public async Task TimedDevelopmentClientStopsThroughTheProtocol()
    {
        await using FakeDevelopmentTransport transport = new() { QueueStoppedAfterStop = true };
        transport.QueueText(new { type = "READY", protocolVersion = 1 });
        transport.QueueText(new { type = "STATUS", protocolVersion = 1, status = "capturing" });
        using CancellationTokenSource cancellation = new();

        int result = await AudioCompanionDevelopmentClient.RunCoreAsync(
            ValidToken,
            TextWriter.Null,
            TextWriter.Null,
            transport,
            cancellation,
            TimeSpan.FromMilliseconds(25));

        Assert.AreEqual(0, result);
        Assert.Contains("STOP", transport.SentTypes);
        Assert.AreEqual(1, transport.CloseCount);
    }

    [TestMethod]
    public async Task DevelopmentCliArgumentsAndStdinLifetimeAreStrict()
    {
        Assert.IsTrue(Program.TryParseServerArguments(
            ["server", "--token-stdin", "--stop-on-stdin-eof"],
            out bool stopOnStdinEof));
        Assert.IsTrue(stopOnStdinEof);
        Assert.IsFalse(Program.TryParseServerArguments(
            ["server", "--token-stdin", "--unknown"],
            out _));
        Assert.IsTrue(Program.TryParseDevelopmentClientArguments(
            ["server-test-client", "--token-stdin", "--duration-seconds", "10"],
            out TimeSpan? duration));
        Assert.AreEqual(TimeSpan.FromSeconds(10), duration);
        Assert.IsFalse(Program.TryParseDevelopmentClientArguments(
            ["server-test-client", "--token-stdin", "--duration-seconds", "0"],
            out _));
        Assert.IsFalse(Program.TryParseDevelopmentClientArguments(
            ["server-test-client", "--token-stdin", "--duration-seconds", "+10"],
            out _));

        using CancellationTokenSource cancellation = new();
        Task shutdown = Task.Delay(Timeout.InfiniteTimeSpan, cancellation.Token);
        await Assert.ThrowsExactlyAsync<TaskCanceledException>(() =>
            Program.WaitForServerLifetimeAsync(shutdown, Task.FromResult(string.Empty), cancellation));
        Assert.IsTrue(cancellation.IsCancellationRequested);
    }

    [TestMethod]
    public async Task StdinEofMonitorRunsOutsideTheServerStartupThread()
    {
        int callerThreadId = Environment.CurrentManagedThreadId;
        DeferredTextReader reader = new();

        Task<string> monitor = Program.MonitorStdinEofAsync(reader, CancellationToken.None);
        int readerThreadId = await reader.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.AreNotEqual(callerThreadId, readerThreadId);
        Assert.IsFalse(monitor.IsCompleted);

        reader.Complete("closed");
        Assert.AreEqual("closed", await monitor.WaitAsync(TimeSpan.FromSeconds(1)));
    }

    private static ClientControlMessage Parse<T>(T value) =>
        AudioCompanionControlCodec.ParseClient(JsonSerializer.SerializeToUtf8Bytes(value));

    private static object HelloMessage(string token = ValidToken) => new
    {
        type = "HELLO",
        protocolVersion = 1,
        sessionId = "session-1",
        clientVersion = "1.0.0",
        auth = new { scheme = "pairing-token", token },
    };

    private static object StartMessage(long offset, string sourceId = AudioCompanionProtocol.SourceId, int sampleRate = 16000) => new
    {
        type = "START",
        protocolVersion = 1,
        sessionId = "session-1",
        sourceId,
        format = new { sampleFormat = "s16le", sampleRate, channels = 1 },
        sessionStartedAtUnixMs = 1_000_000,
        captureStartOffsetMs = offset,
    };

    private static object StopMessage() => new
    {
        type = "STOP",
        protocolVersion = 1,
        sessionId = "session-1",
    };

    private static AudioFrame Frame() => new(0, 0, 0, new byte[640], 0);

    private sealed class DeferredTextReader : TextReader
    {
        private readonly TaskCompletionSource<string> completion = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<int> Started { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public void Complete(string value) => completion.TrySetResult(value);

        public override Task<string> ReadToEndAsync(CancellationToken cancellationToken)
        {
            Started.TrySetResult(Environment.CurrentManagedThreadId);
            return completion.Task.WaitAsync(cancellationToken);
        }
    }

    private static GoldenFrame LoadFixture()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "fixtures", "audio-companion-frame-v1.json");
        return JsonSerializer.Deserialize<GoldenFrame>(File.ReadAllText(path), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("Fixture is unavailable.");
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(3));
        while (!condition())
        {
            await Task.Delay(5, timeout.Token);
        }
    }

    private sealed record GoldenFrame(
        uint Sequence,
        ulong OffsetMs,
        uint SampleRate,
        byte Channels,
        string SampleFormat,
        uint SampleCount,
        string PcmHex,
        string PacketHex);

    private sealed class FakeClock : IMonotonicClock
    {
        public long Timestamp { get; set; }

        public long Frequency { get; set; }
    }

    private sealed class FakeSocket : IAudioCompanionSocket
    {
        private readonly Channel<(byte[] Bytes, WebSocketMessageType Type)> incoming = Channel.CreateUnbounded<(byte[], WebSocketMessageType)>();
        private readonly TaskCompletionSource errorSendRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<(byte[] Bytes, WebSocketMessageType Type)> Sent { get; } = [];

        public List<string> Lifecycle { get; } = [];

        public WebSocketState State { get; private set; } = WebSocketState.Open;

        public int DisposeCount { get; private set; }

        public int CloseCount { get; private set; }

        public bool BlockErrorSend { get; init; }

        public TaskCompletionSource ErrorSendStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void QueueText(object value) => incoming.Writer.TryWrite((JsonSerializer.SerializeToUtf8Bytes(value), WebSocketMessageType.Text));

        public void QueueBinary(byte[] bytes) => incoming.Writer.TryWrite((bytes, WebSocketMessageType.Binary));

        public async ValueTask<WebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken cancellationToken)
        {
            (byte[] bytes, WebSocketMessageType type) = await incoming.Reader.ReadAsync(cancellationToken);
            bytes.CopyTo(buffer);
            return new WebSocketReceiveResult(bytes.Length, type, true);
        }

        public async ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, CancellationToken cancellationToken)
        {
            string? description = messageType == WebSocketMessageType.Text
                ? DescribeText(buffer.Span)
                : null;
            if (BlockErrorSend && description?.StartsWith("ERROR:", StringComparison.Ordinal) == true)
            {
                ErrorSendStarted.TrySetResult();
                await errorSendRelease.Task.WaitAsync(cancellationToken);
            }

            lock (Sent)
            {
                Sent.Add((buffer.ToArray(), messageType));
                if (description is not null)
                {
                    Lifecycle.Add(description);
                }
            }
        }

        public ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken)
        {
            State = WebSocketState.Closed;
            CloseCount++;
            Lifecycle.Add("CLOSE");
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            State = WebSocketState.Closed;
            DisposeCount++;
            incoming.Writer.TryComplete();
            return ValueTask.CompletedTask;
        }

        public IReadOnlyList<string> SentTextTypes()
        {
            lock (Sent)
            {
                return Sent.Where(item => item.Type == WebSocketMessageType.Text)
                    .Select(item => DescribeText(item.Bytes))
                    .ToArray();
            }
        }

        public void ReleaseErrorSend() => errorSendRelease.TrySetResult();

        private static string DescribeText(ReadOnlySpan<byte> bytes)
        {
            using JsonDocument document = JsonDocument.Parse(bytes.ToArray());
            string type = document.RootElement.GetProperty("type").GetString()!;
            return type switch
            {
                "STATUS" => $"STATUS:{document.RootElement.GetProperty("status").GetString()}",
                "ERROR" => $"ERROR:{document.RootElement.GetProperty("code").GetString()}",
                _ => type,
            };
        }
    }

    private sealed class FakeCaptureFactory : IAudioServerCaptureFactory
    {
        public int Created { get; private set; }

        public IAudioServerCapture Create(IAudioFrameSink sink)
        {
            Created++;
            return new FakeCapture();
        }
    }

    private sealed class FakeCapture : IAudioServerCapture
    {
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Completion => completion.Task;

        public AudioProbeErrorCode? ErrorCode => null;

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync()
        {
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            completion.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ThrowingCaptureFactory : IAudioServerCaptureFactory
    {
        public IAudioServerCapture Create(IAudioFrameSink sink) =>
            throw new AudioProbeException(AudioProbeErrorCode.CaptureInitializationFailed);
    }

    private sealed class EarlyFrameCaptureFactory : IAudioServerCaptureFactory
    {
        public IAudioServerCapture Create(IAudioFrameSink sink) => new EarlyFrameCapture(sink);
    }

    private sealed class EarlyFrameCapture(IAudioFrameSink sink) : IAudioServerCapture
    {
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Completion => completion.Task;

        public AudioProbeErrorCode? ErrorCode => null;

        public Task StartAsync(CancellationToken cancellationToken)
        {
            sink.TryAccept(Frame(), new AudioFrameCaptureMetadata(1000, 20));
            return Task.CompletedTask;
        }

        public Task StopAsync()
        {
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            completion.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TrackingCaptureFactory : IAudioServerCaptureFactory
    {
        public IAudioFrameSink? Sink { get; private set; }

        public TrackingCapture? Capture { get; private set; }

        public IAudioServerCapture Create(IAudioFrameSink sink)
        {
            Sink = sink;
            Capture = new TrackingCapture();
            return Capture;
        }
    }

    private sealed class TrackingCapture : IAudioServerCapture
    {
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int StopCount { get; private set; }

        public int DisposeCount { get; private set; }

        public Task Completion => completion.Task;

        public AudioProbeErrorCode? ErrorCode => null;

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync()
        {
            StopCount++;
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            completion.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FaultingCaptureFactory : IAudioServerCaptureFactory
    {
        public FaultingCapture Capture { get; } = new();

        public IAudioServerCapture Create(IAudioFrameSink sink) => Capture;
    }

    private sealed class FaultingCapture : IAudioServerCapture
    {
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int StopCount { get; private set; }

        public int DisposeCount { get; private set; }

        public Task Completion => completion.Task;

        public AudioProbeErrorCode? ErrorCode { get; private set; }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync()
        {
            StopCount++;
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            completion.TrySetResult();
            return ValueTask.CompletedTask;
        }

        public void Fail(AudioProbeErrorCode errorCode)
        {
            ErrorCode = errorCode;
            completion.TrySetResult();
        }
    }

    private sealed class FakeDevelopmentTransport : IAudioCompanionDevelopmentTransport
    {
        private readonly Channel<(byte[] Bytes, WebSocketMessageType Type)> incoming =
            Channel.CreateUnbounded<(byte[], WebSocketMessageType)>();

        public WebSocketState State { get; private set; } = WebSocketState.None;

        public List<string> SentTypes { get; } = [];

        public bool QueueStoppedAfterStop { get; init; }

        public int CloseCount { get; private set; }

        public void QueueText(object value) => incoming.Writer.TryWrite((
            JsonSerializer.SerializeToUtf8Bytes(value),
            WebSocketMessageType.Text));

        public ValueTask ConnectAsync(Uri endpoint, CancellationToken cancellationToken)
        {
            State = WebSocketState.Open;
            return ValueTask.CompletedTask;
        }

        public async ValueTask<WebSocketReceiveResult> ReceiveAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken)
        {
            (byte[] bytes, WebSocketMessageType type) = await incoming.Reader.ReadAsync(cancellationToken);
            try
            {
                bytes.CopyTo(buffer);
                return new WebSocketReceiveResult(bytes.Length, type, true);
            }
            finally
            {
                System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes);
            }
        }

        public ValueTask SendAsync(
            ReadOnlyMemory<byte> buffer,
            WebSocketMessageType messageType,
            CancellationToken cancellationToken)
        {
            using JsonDocument document = JsonDocument.Parse(buffer);
            string type = document.RootElement.GetProperty("type").GetString()!;
            SentTypes.Add(type);
            if (QueueStoppedAfterStop && type == "STOP")
            {
                QueueText(new { type = "STATUS", protocolVersion = 1, status = "stopped" });
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask CloseAsync(
            WebSocketCloseStatus status,
            string description,
            CancellationToken cancellationToken)
        {
            State = WebSocketState.Closed;
            CloseCount++;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            State = WebSocketState.Closed;
            incoming.Writer.TryComplete();
            return ValueTask.CompletedTask;
        }
    }
}

internal static class TestStringExtensions
{
    public static string Repeat(this string value, int count) => string.Concat(Enumerable.Repeat(value, count));
}
