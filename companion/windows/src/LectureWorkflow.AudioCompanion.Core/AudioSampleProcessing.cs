using System.Buffers.Binary;

namespace LectureWorkflow.AudioCompanion.Core;

public static class AudioSampleProcessing
{
    public static float Sanitize(float sample)
    {
        if (float.IsNaN(sample))
        {
            return 0;
        }

        return Math.Clamp(sample, -1f, 1f);
    }

    public static float[] DownmixToMono(ReadOnlySpan<float> interleavedSamples, int channels)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(channels);
        if (interleavedSamples.Length % channels != 0)
        {
            throw new ArgumentException("Interleaved sample count must be divisible by the channel count.", nameof(interleavedSamples));
        }

        float[] mono = new float[interleavedSamples.Length / channels];
        for (int frame = 0; frame < mono.Length; frame++)
        {
            double sum = 0;
            int sourceOffset = frame * channels;
            for (int channel = 0; channel < channels; channel++)
            {
                sum += Sanitize(interleavedSamples[sourceOffset + channel]);
            }

            mono[frame] = Sanitize((float)(sum / channels));
        }

        return mono;
    }

    public static short ToInt16(float sample)
    {
        float safeSample = Sanitize(sample);
        if (safeSample <= -1f)
        {
            return short.MinValue;
        }

        if (safeSample >= 1f)
        {
            return short.MaxValue;
        }

        return (short)Math.Round(safeSample * short.MaxValue, MidpointRounding.AwayFromZero);
    }

    public static byte[] EncodePcm16LittleEndian(ReadOnlySpan<float> samples)
    {
        byte[] bytes = new byte[checked(samples.Length * sizeof(short))];
        for (int index = 0; index < samples.Length; index++)
        {
            BinaryPrimitives.WriteInt16LittleEndian(
                bytes.AsSpan(index * sizeof(short), sizeof(short)),
                ToInt16(samples[index]));
        }

        return bytes;
    }
}
