using System.Buffers.Binary;

namespace LectureWorkflow.AudioCompanion.Core;

public sealed class StreamingAudioDecoder
{
    private readonly AudioInputFormat format;
    private byte[] remainder = [];

    public StreamingAudioDecoder(AudioInputFormat format)
    {
        ArgumentNullException.ThrowIfNull(format);
        format.Validate();
        this.format = format;
    }

    public int PendingByteCount => remainder.Length;

    public float[] Decode(ReadOnlySpan<byte> input)
    {
        if (input.IsEmpty)
        {
            return [];
        }

        byte[] combined = new byte[checked(remainder.Length + input.Length)];
        remainder.CopyTo(combined, 0);
        input.CopyTo(combined.AsSpan(remainder.Length));

        int completeLength = combined.Length - (combined.Length % format.BlockAlign);
        int sampleCount = completeLength / format.BytesPerSample;
        float[] samples = new float[sampleCount];
        ReadOnlySpan<byte> bytes = combined.AsSpan(0, completeLength);

        for (int sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
        {
            int byteOffset = sampleIndex * format.BytesPerSample;
            samples[sampleIndex] = DecodeSample(bytes.Slice(byteOffset, format.BytesPerSample));
        }

        remainder = combined.AsSpan(completeLength).ToArray();
        return samples;
    }

    public void Reset() => remainder = [];

    private float DecodeSample(ReadOnlySpan<byte> sample)
    {
        if (format.Encoding == AudioSampleEncoding.IeeeFloat)
        {
            int bits = BinaryPrimitives.ReadInt32LittleEndian(sample);
            return BitConverter.Int32BitsToSingle(bits);
        }

        int containerValue = format.BitsPerSample switch
        {
            16 => BinaryPrimitives.ReadInt16LittleEndian(sample),
            24 => ReadInt24LittleEndian(sample),
            32 => BinaryPrimitives.ReadInt32LittleEndian(sample),
            _ => throw new AudioProbeException(AudioProbeErrorCode.UnsupportedInputFormat),
        };

        int validBits = format.EffectiveBitsPerSample;
        int value = containerValue >> (format.BitsPerSample - validBits);
        double negativeScale = Math.Pow(2, validBits - 1);
        double positiveScale = negativeScale - 1;
        return (float)(value < 0 ? value / negativeScale : value / positiveScale);
    }

    private static int ReadInt24LittleEndian(ReadOnlySpan<byte> sample)
    {
        int value = sample[0] | (sample[1] << 8) | (sample[2] << 16);
        return (value & 0x0080_0000) != 0 ? value | unchecked((int)0xFF00_0000) : value;
    }
}
