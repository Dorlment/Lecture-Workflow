using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Windows;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class AudioProbeSessionTests
{
    [TestMethod]
    public async Task CapturedDataIsCopiedAndProcessed()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        CountingBufferPool pool = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter, pool);
        await session.StartAsync();

        backend.Emit(EncodeFloats(Enumerable.Repeat(0.5f, 320).ToArray()));
        await WaitUntilAsync(() => session.FrameCount == 1);
        await session.StopAsync();

        Assert.AreEqual(1L, session.FrameCount);
        Assert.AreEqual(pool.RentCount, pool.ReturnCount);
        Assert.AreEqual(AudioProbeSessionState.Stopped, session.State);
    }

    [TestMethod]
    public async Task RepeatedStopIsIdempotent()
    {
        FakeCaptureBackend backend = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), new FakeReporter());
        await session.StartAsync();

        await session.StopAsync();
        await session.StopAsync();

        Assert.AreEqual(1, backend.StopCount);
        Assert.AreEqual(1, backend.DisposeCount);
    }

    [TestMethod]
    public async Task CancellationStopsAndReleasesCapture()
    {
        FakeCaptureBackend backend = new();
        using CancellationTokenSource cancellation = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), new FakeReporter());
        await session.StartAsync(cancellation.Token);

        cancellation.Cancel();
        await session.Completion;

        Assert.AreEqual(AudioProbeSessionState.Stopped, session.State);
        Assert.AreEqual(1, backend.DisposeCount);
    }

    [TestMethod]
    public async Task DefaultDeviceChangeStopsWithStableError()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter);
        await session.StartAsync();

        backend.ChangeDefaultDevice();
        await session.Completion;

        Assert.AreEqual(AudioProbeSessionState.Faulted, session.State);
        Assert.AreEqual(AudioProbeErrorCode.DefaultDeviceChanged, reporter.Error);
        Assert.AreEqual(1, backend.DisposeCount);
    }

    [TestMethod]
    public async Task DeviceInvalidationStopsWithStableError()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter);
        await session.StartAsync();

        backend.InvalidateDevice();
        await session.Completion;

        Assert.AreEqual(AudioProbeErrorCode.DeviceInvalidated, reporter.Error);
    }

    [TestMethod]
    public async Task CaptureFailureStopsWithSafeError()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter);
        await session.StartAsync();

        backend.Fail(new InvalidOperationException("sensitive-device-value"));
        await session.Completion;

        Assert.AreEqual(AudioProbeErrorCode.CaptureFailed, reporter.Error);
        Assert.DoesNotContain("sensitive-device-value", reporter.Messages);
    }

    [TestMethod]
    public async Task InitializationFailureIsMappedAndReleased()
    {
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new ThrowingFactory(), reporter);

        AudioProbeException exception = await Assert.ThrowsExactlyAsync<AudioProbeException>(() => session.StartAsync());

        Assert.AreEqual(AudioProbeErrorCode.CaptureInitializationFailed, exception.Code);
        Assert.AreEqual(AudioProbeErrorCode.CaptureInitializationFailed, reporter.Error);
    }

    [TestMethod]
    public async Task MissingDefaultDeviceKeepsItsStableErrorCode()
    {
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(
            new ErrorFactory(AudioProbeErrorCode.DefaultDeviceUnavailable),
            reporter);

        AudioProbeException exception = await Assert.ThrowsExactlyAsync<AudioProbeException>(() => session.StartAsync());

        Assert.AreEqual(AudioProbeErrorCode.DefaultDeviceUnavailable, exception.Code);
        Assert.AreEqual(AudioProbeErrorCode.DefaultDeviceUnavailable, reporter.Error);
    }

    [TestMethod]
    public async Task BackendStartFailureDisposesInitializedBackend()
    {
        FakeCaptureBackend backend = new() { StartException = new InvalidOperationException("private-device-identifier") };
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter);

        AudioProbeException exception = await Assert.ThrowsExactlyAsync<AudioProbeException>(() => session.StartAsync());

        Assert.AreEqual(AudioProbeErrorCode.CaptureInitializationFailed, exception.Code);
        Assert.AreEqual(1, backend.DisposeCount);
        Assert.DoesNotContain("private-device-identifier", reporter.Messages);
    }

    [TestMethod]
    public async Task BackpressureStopsAndReturnsRejectedBufferExactlyOnce()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        CountingBufferPool pool = new();
        await using AudioProbeSession session = new(
            new FakeFactory(backend),
            reporter,
            pool,
            queueChunkCapacity: 1,
            queueByteCapacity: 8);
        await session.StartAsync();

        backend.Emit(new byte[16]);
        await session.Completion;

        Assert.AreEqual(AudioProbeErrorCode.CaptureBackpressure, reporter.Error);
        Assert.AreEqual(1, pool.RentCount);
        Assert.AreEqual(1, pool.ReturnCount);
    }

    [TestMethod]
    public async Task StartingTwiceIsRejected()
    {
        FakeCaptureBackend backend = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), new FakeReporter());
        await session.StartAsync();

        await Assert.ThrowsExactlyAsync<InvalidOperationException>(() => session.StartAsync());
        await session.StopAsync();

        Assert.AreEqual(1, backend.StartCount);
    }

    [TestMethod]
    public async Task DisposeStopsActiveSessionAndReturnsBuffers()
    {
        FakeCaptureBackend backend = new();
        CountingBufferPool pool = new();
        AudioProbeSession session = new(new FakeFactory(backend), new FakeReporter(), pool);
        await session.StartAsync();
        backend.Emit(EncodeFloats(new float[319]));

        await session.DisposeAsync();

        Assert.AreEqual(AudioProbeSessionState.Disposed, session.State);
        Assert.AreEqual(pool.RentCount, pool.ReturnCount);
    }

    [TestMethod]
    public async Task ReporterNeverReceivesAudioBytesOrBackendExceptionText()
    {
        FakeCaptureBackend backend = new();
        FakeReporter reporter = new();
        await using AudioProbeSession session = new(new FakeFactory(backend), reporter);
        await session.StartAsync();
        backend.Emit(EncodeFloats(Enumerable.Repeat(0.25f, 320).ToArray()));
        await WaitUntilAsync(() => session.FrameCount == 1);
        backend.Fail(new Exception("data:audio/pcm;base64,SECRETPCM"));
        await session.Completion;

        Assert.DoesNotContain("SECRETPCM", reporter.Messages);
        Assert.DoesNotContain("base64", reporter.Messages);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
        while (!condition())
        {
            await Task.Delay(5, timeout.Token);
        }
    }

    private static byte[] EncodeFloats(float[] samples)
    {
        byte[] bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    private sealed class FakeFactory(IAudioCaptureBackend backend) : IAudioCaptureBackendFactory
    {
        public IAudioCaptureBackend Create() => backend;
    }

    private sealed class ThrowingFactory : IAudioCaptureBackendFactory
    {
        public IAudioCaptureBackend Create() =>
            throw new InvalidOperationException("private-device-identifier");
    }

    private sealed class ErrorFactory(AudioProbeErrorCode errorCode) : IAudioCaptureBackendFactory
    {
        public IAudioCaptureBackend Create() => throw new AudioProbeException(errorCode);
    }

    private sealed class FakeCaptureBackend : IAudioCaptureBackend
    {
        public AudioInputFormat InputFormat { get; } = new(16_000, 1, 32, AudioSampleEncoding.IeeeFloat);

        public int StartCount { get; private set; }

        public int StopCount { get; private set; }

        public int DisposeCount { get; private set; }

        public Exception? StartException { get; init; }

        public event EventHandler<AudioDataAvailableEventArgs>? DataAvailable;

        public event EventHandler<AudioCaptureStoppedEventArgs>? CaptureStopped;

        public event EventHandler? DefaultDeviceChanged;

        public event EventHandler? DeviceInvalidated;

        public void Start()
        {
            StartCount++;
            if (StartException is not null)
            {
                throw StartException;
            }
        }

        public void Stop() => StopCount++;

        public void Dispose() => DisposeCount++;

        public void Emit(byte[] bytes) => DataAvailable?.Invoke(this, new AudioDataAvailableEventArgs(bytes, bytes.Length));

        public void Fail(Exception exception) => CaptureStopped?.Invoke(this, new AudioCaptureStoppedEventArgs(exception));

        public void ChangeDefaultDevice() => DefaultDeviceChanged?.Invoke(this, EventArgs.Empty);

        public void InvalidateDevice() => DeviceInvalidated?.Invoke(this, EventArgs.Empty);
    }

    private sealed class FakeReporter : IProbeReporter
    {
        private readonly List<string> messages = [];

        public AudioProbeErrorCode? Error { get; private set; }

        public string Messages => string.Join('|', messages);

        public void ReportStarting() => messages.Add("starting");

        public void ReportCapturing(AudioInputFormat format) => messages.Add($"capturing:{format.SampleRate}:{format.Channels}");

        public void ReportFrame(long frameCount, double rms) => messages.Add($"frame:{frameCount}:{rms:F3}");

        public void ReportStopping() => messages.Add("stopping");

        public void ReportStopped(long frameCount) => messages.Add($"stopped:{frameCount}");

        public void ReportError(AudioProbeErrorCode errorCode)
        {
            Error = errorCode;
            messages.Add(AudioProbeException.ToStableCode(errorCode));
        }
    }

    private sealed class CountingBufferPool : IAudioBufferPool
    {
        public int RentCount { get; private set; }

        public int ReturnCount { get; private set; }

        public byte[] Rent(int minimumLength)
        {
            RentCount++;
            return new byte[minimumLength];
        }

        public void Return(byte[] buffer) => ReturnCount++;
    }
}
