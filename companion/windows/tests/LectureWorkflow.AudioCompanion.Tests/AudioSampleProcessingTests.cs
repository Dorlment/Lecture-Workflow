using System.Buffers.Binary;
using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class AudioSampleProcessingTests
{
    [TestMethod]
    public void DownmixMonoPreservesSamples()
    {
        float[] result = AudioSampleProcessing.DownmixToMono([0.5f, -0.25f], 1);

        CollectionAssert.AreEqual(new[] { 0.5f, -0.25f }, result);
    }

    [TestMethod]
    public void DownmixStereoAveragesChannels()
    {
        float[] result = AudioSampleProcessing.DownmixToMono([1f, -1f, 0.25f, 0.75f], 2);

        CollectionAssert.AreEqual(new[] { 0f, 0.5f }, result);
    }

    [TestMethod]
    public void DownmixMultipleChannelsAveragesAllChannels()
    {
        float[] result = AudioSampleProcessing.DownmixToMono([1f, 0.5f, -0.5f, -1f], 4);

        Assert.AreEqual(0f, result[0], 0.0001f);
    }

    [TestMethod]
    public void DownmixRejectsPartialInterleavedFrame()
    {
        Assert.ThrowsExactly<ArgumentException>(() => AudioSampleProcessing.DownmixToMono([1f, 2f, 3f], 2));
    }

    [TestMethod]
    public void SanitizeConvertsNanToZero()
    {
        Assert.AreEqual(0f, AudioSampleProcessing.Sanitize(float.NaN));
    }

    [TestMethod]
    public void SanitizeClampsInfinityAndOutOfRangeValues()
    {
        Assert.AreEqual(1f, AudioSampleProcessing.Sanitize(float.PositiveInfinity));
        Assert.AreEqual(-1f, AudioSampleProcessing.Sanitize(float.NegativeInfinity));
        Assert.AreEqual(1f, AudioSampleProcessing.Sanitize(2f));
        Assert.AreEqual(-1f, AudioSampleProcessing.Sanitize(-2f));
    }

    [TestMethod]
    public void Int16ConversionUsesRequiredBoundaries()
    {
        Assert.AreEqual(short.MinValue, AudioSampleProcessing.ToInt16(-1f));
        Assert.AreEqual(short.MaxValue, AudioSampleProcessing.ToInt16(1f));
        Assert.AreEqual((short)0, AudioSampleProcessing.ToInt16(float.NaN));
    }

    [TestMethod]
    public void PcmEncodingIsSigned16BitLittleEndian()
    {
        byte[] encoded = AudioSampleProcessing.EncodePcm16LittleEndian([-1f, 0f, 1f]);

        Assert.HasCount(6, encoded);
        Assert.AreEqual(short.MinValue, BinaryPrimitives.ReadInt16LittleEndian(encoded.AsSpan(0, 2)));
        Assert.AreEqual((short)0, BinaryPrimitives.ReadInt16LittleEndian(encoded.AsSpan(2, 2)));
        Assert.AreEqual(short.MaxValue, BinaryPrimitives.ReadInt16LittleEndian(encoded.AsSpan(4, 2)));
    }
}
