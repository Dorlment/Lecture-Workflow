using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class AudioDataAvailableEventArgs(byte[] buffer, int count, long? captureTimestamp = null) : EventArgs
{
    public byte[] Buffer { get; } = buffer ?? throw new ArgumentNullException(nameof(buffer));

    public int Count { get; } = count >= 0 && count <= buffer.Length
        ? count
        : throw new ArgumentOutOfRangeException(nameof(count));

    public long CaptureTimestamp { get; } = captureTimestamp ?? System.Diagnostics.Stopwatch.GetTimestamp();
}

public sealed class AudioCaptureStoppedEventArgs(Exception? exception) : EventArgs
{
    public Exception? Exception { get; } = exception;
}

public interface IAudioCaptureBackend : IDisposable
{
    AudioInputFormat InputFormat { get; }

    event EventHandler<AudioDataAvailableEventArgs>? DataAvailable;

    event EventHandler<AudioCaptureStoppedEventArgs>? CaptureStopped;

    event EventHandler? DefaultDeviceChanged;

    event EventHandler? DeviceInvalidated;

    void Start();

    void Stop();
}

public interface IAudioCaptureBackendFactory
{
    IAudioCaptureBackend Create();
}

public interface IProbeReporter
{
    void ReportStarting();

    void ReportCapturing(AudioInputFormat format);

    void ReportFrame(long frameCount, double rms);

    void ReportStopping();

    void ReportStopped(long frameCount);

    void ReportError(AudioProbeErrorCode errorCode);
}

public sealed record AudioFrameCaptureMetadata(long EstimatedCaptureTimestamp, double BatchDurationMs);

public interface IAudioFrameSink
{
    bool TryAccept(AudioFrame frame, AudioFrameCaptureMetadata metadata);
}

public enum AudioProbeSessionState
{
    Idle,
    Starting,
    Capturing,
    Stopping,
    Stopped,
    Faulted,
    Disposed,
}
