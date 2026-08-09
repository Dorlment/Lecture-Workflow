using System.Diagnostics;
using System.Security.Cryptography;
using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Protocol;

namespace LectureWorkflow.AudioCompanion.Windows;

public interface IMonotonicClock
{
    long Timestamp { get; }

    long Frequency { get; }
}

public sealed class StopwatchMonotonicClock : IMonotonicClock
{
    public static StopwatchMonotonicClock Instance { get; } = new();

    private StopwatchMonotonicClock()
    {
    }

    public long Timestamp => Stopwatch.GetTimestamp();

    public long Frequency => Stopwatch.Frequency;
}

public sealed class WireAudioFrameSink : IAudioFrameSink
{
    private readonly BoundedWebSocketSender sender;
    private readonly IMonotonicClock clock;
    private readonly long startTimestamp;
    private readonly ulong captureStartOffsetMs;
    private readonly Action<string> onFatalError;
    private readonly object sync = new();
    private ulong previousOffsetMs;
    private uint nextSequence;
    private bool hasFrame;
    private bool enabled;
    private bool stopped;

    public WireAudioFrameSink(
        BoundedWebSocketSender sender,
        IMonotonicClock clock,
        long startTimestamp,
        ulong captureStartOffsetMs,
        Action<string> onFatalError)
    {
        this.sender = sender ?? throw new ArgumentNullException(nameof(sender));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.startTimestamp = startTimestamp;
        this.captureStartOffsetMs = captureStartOffsetMs;
        this.onFatalError = onFatalError ?? throw new ArgumentNullException(nameof(onFatalError));
    }

    public void Enable()
    {
        lock (sync)
        {
            if (!stopped)
            {
                enabled = true;
            }
        }
    }

    public void Stop()
    {
        lock (sync)
        {
            stopped = true;
            enabled = false;
        }
    }

    public bool TryAccept(AudioFrame frame, AudioFrameCaptureMetadata metadata)
    {
        lock (sync)
        {
            if (!enabled || stopped)
            {
                return false;
            }

            if (nextSequence == uint.MaxValue)
            {
                enabled = false;
                onFatalError("sequence-exhausted");
                return false;
            }

            double elapsedMs = Math.Max(0d, metadata.EstimatedCaptureTimestamp - startTimestamp)
                * 1000d / clock.Frequency;
            ulong estimated = checked(captureStartOffsetMs + (ulong)Math.Floor(elapsedMs));
            ulong offset = hasFrame ? Math.Max(estimated, checked(previousOffsetMs + 20)) : Math.Max(estimated, captureStartOffsetMs);
            if (offset > AudioCompanionProtocol.MaxSafeInteger)
            {
                enabled = false;
                onFatalError("offset-out-of-range");
                return false;
            }

            byte[] packet;
            try
            {
                packet = AudioCompanionProtocol.EncodeFrame(nextSequence, offset, frame.Pcm);
            }
            catch
            {
                enabled = false;
                onFatalError("frame-encode-failed");
                return false;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(frame.Pcm);
            }

            if (!sender.TrySendAudio(packet))
            {
                enabled = false;
                onFatalError("send-backpressure");
                return false;
            }

            previousOffsetMs = offset;
            hasFrame = true;
            nextSequence++;
            return true;
        }
    }
}
