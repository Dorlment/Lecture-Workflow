using NAudio.Wave;

namespace LectureWorkflow.AudioCompanion.Core;

internal sealed class BufferedMonoSampleProvider : ISampleProvider
{
    private float[] samples = [];
    private int readPosition;
    private int writePosition;

    public BufferedMonoSampleProvider(int sampleRate)
    {
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 1);
    }

    public WaveFormat WaveFormat { get; }

    public int AvailableSamples => writePosition - readPosition;

    public void Add(ReadOnlySpan<float> newSamples)
    {
        if (newSamples.IsEmpty)
        {
            return;
        }

        CompactOrGrow(newSamples.Length);
        newSamples.CopyTo(samples.AsSpan(writePosition));
        writePosition += newSamples.Length;
    }

    public int Read(float[] buffer, int offset, int count)
    {
        int toCopy = Math.Min(count, AvailableSamples);
        samples.AsSpan(readPosition, toCopy).CopyTo(buffer.AsSpan(offset, toCopy));
        readPosition += toCopy;
        if (readPosition == writePosition)
        {
            readPosition = 0;
            writePosition = 0;
        }

        return toCopy;
    }

    private void CompactOrGrow(int additionalSamples)
    {
        int available = AvailableSamples;
        int required = checked(available + additionalSamples);
        if (samples.Length < required)
        {
            int newLength = Math.Max(required, Math.Max(4096, samples.Length * 2));
            float[] replacement = new float[newLength];
            samples.AsSpan(readPosition, available).CopyTo(replacement);
            samples = replacement;
        }
        else if (readPosition > 0)
        {
            samples.AsSpan(readPosition, available).CopyTo(samples);
        }

        readPosition = 0;
        writePosition = available;
    }
}
