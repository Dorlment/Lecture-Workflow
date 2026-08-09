namespace LectureWorkflow.AudioCompanion.Core;

public sealed class FixedFrameAssembler
{
    public const int TargetSampleRate = 16_000;
    public const int SamplesPerFrame = 320;
    public const int BytesPerFrame = SamplesPerFrame * sizeof(short);

    private readonly float[] pending = new float[SamplesPerFrame];
    private int pendingCount;
    private long sequence;
    private long emittedSamples;

    public int PendingSampleCount => pendingCount;

    public IReadOnlyList<AudioFrame> Add(ReadOnlySpan<float> samples)
    {
        List<AudioFrame> frames = [];
        while (!samples.IsEmpty)
        {
            int copyCount = Math.Min(SamplesPerFrame - pendingCount, samples.Length);
            samples[..copyCount].CopyTo(pending.AsSpan(pendingCount));
            pendingCount += copyCount;
            samples = samples[copyCount..];

            if (pendingCount == SamplesPerFrame)
            {
                frames.Add(CreateFrame());
                pendingCount = 0;
            }
        }

        return frames;
    }

    public void DiscardRemainder() => pendingCount = 0;

    private AudioFrame CreateFrame()
    {
        double sumSquares = 0;
        for (int index = 0; index < pending.Length; index++)
        {
            float sample = AudioSampleProcessing.Sanitize(pending[index]);
            sumSquares += sample * sample;
        }

        double offsetMs = emittedSamples * 1000d / TargetSampleRate;
        AudioFrame frame = new(
            sequence++,
            emittedSamples,
            offsetMs,
            AudioSampleProcessing.EncodePcm16LittleEndian(pending),
            Math.Sqrt(sumSquares / SamplesPerFrame));
        emittedSamples += SamplesPerFrame;
        return frame;
    }
}
