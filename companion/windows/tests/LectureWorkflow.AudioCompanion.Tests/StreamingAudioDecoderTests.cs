using System.Buffers.Binary;
using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class StreamingAudioDecoderTests
{
    [TestMethod]
    public void DecodesPcm16Boundaries()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(16_000, 1, 16, AudioSampleEncoding.PcmInteger));
        byte[] input = new byte[6];
        BinaryPrimitives.WriteInt16LittleEndian(input.AsSpan(0, 2), short.MinValue);
        BinaryPrimitives.WriteInt16LittleEndian(input.AsSpan(2, 2), 0);
        BinaryPrimitives.WriteInt16LittleEndian(input.AsSpan(4, 2), short.MaxValue);

        float[] result = decoder.Decode(input);

        Assert.AreEqual(-1f, result[0]);
        Assert.AreEqual(0f, result[1]);
        Assert.AreEqual(1f, result[2]);
    }

    [TestMethod]
    public void DecodesSignedPcm24()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 1, 24, AudioSampleEncoding.PcmInteger));
        float[] result = decoder.Decode([0x00, 0x00, 0x80, 0xFF, 0xFF, 0x7F]);

        Assert.AreEqual(-1f, result[0]);
        Assert.AreEqual(1f, result[1]);
    }

    [TestMethod]
    public void DecodesPcm32()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 1, 32, AudioSampleEncoding.PcmInteger));
        byte[] input = new byte[8];
        BinaryPrimitives.WriteInt32LittleEndian(input.AsSpan(0, 4), int.MinValue);
        BinaryPrimitives.WriteInt32LittleEndian(input.AsSpan(4, 4), int.MaxValue);

        float[] result = decoder.Decode(input);

        Assert.AreEqual(-1f, result[0]);
        Assert.AreEqual(1f, result[1]);
    }

    [TestMethod]
    public void DecodesFloat32WithoutAlteringNan()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 1, 32, AudioSampleEncoding.IeeeFloat));
        byte[] input = EncodeFloats([0.25f, float.NaN]);

        float[] result = decoder.Decode(input);

        Assert.AreEqual(0.25f, result[0]);
        Assert.IsTrue(float.IsNaN(result[1]));
    }

    [TestMethod]
    public void RetainsBytesAcrossArbitraryChunkBoundaries()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 2, 16, AudioSampleEncoding.PcmInteger));

        Assert.IsEmpty(decoder.Decode([0x00, 0x80, 0xFF]));
        Assert.AreEqual(3, decoder.PendingByteCount);
        float[] result = decoder.Decode([0x7F]);

        Assert.HasCount(2, result);
        Assert.AreEqual(-1f, result[0]);
        Assert.AreEqual(1f, result[1]);
        Assert.AreEqual(0, decoder.PendingByteCount);
    }

    [TestMethod]
    public void HonorsValidBitsInLargerContainer()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 1, 32, AudioSampleEncoding.PcmInteger, 24));
        byte[] input = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(input, 0x7FFFFF00);

        float[] result = decoder.Decode(input);

        Assert.AreEqual(1f, result[0]);
    }

    [TestMethod]
    public void RejectsUnsupportedIntegerWidth()
    {
        Assert.ThrowsExactly<AudioProbeException>(() =>
            new StreamingAudioDecoder(new AudioInputFormat(48_000, 1, 8, AudioSampleEncoding.PcmInteger)));
    }

    [TestMethod]
    public void ResetDiscardsResidualBytes()
    {
        StreamingAudioDecoder decoder = new(new AudioInputFormat(48_000, 1, 24, AudioSampleEncoding.PcmInteger));
        decoder.Decode([1, 2]);

        decoder.Reset();

        Assert.AreEqual(0, decoder.PendingByteCount);
    }

    private static byte[] EncodeFloats(float[] samples)
    {
        byte[] bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }
}
