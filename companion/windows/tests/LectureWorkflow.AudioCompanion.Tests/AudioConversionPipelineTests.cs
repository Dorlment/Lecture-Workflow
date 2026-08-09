using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class AudioConversionPipelineTests
{
    [TestMethod]
    [DataRow(44_100)]
    [DataRow(48_000)]
    [DataRow(96_000)]
    public void ResamplesCommonRatesToSixteenKilohertz(int inputRate)
    {
        AudioConversionPipeline pipeline = new(new AudioInputFormat(inputRate, 1, 32, AudioSampleEncoding.IeeeFloat));
        float[] source = CreateSine(inputRate, 440, 1);

        IReadOnlyList<AudioFrame> frames = pipeline.Process(EncodeFloats(source));

        Assert.IsGreaterThanOrEqualTo(49, frames.Count);
        Assert.IsLessThanOrEqualTo(50, frames.Count);
        Assert.IsTrue(frames.All(frame => frame.Pcm.Length == FixedFrameAssembler.BytesPerFrame));
    }

    [TestMethod]
    public void ArbitraryInputBlocksProduceSameFixedFrameShape()
    {
        AudioConversionPipeline pipeline = new(new AudioInputFormat(48_000, 2, 32, AudioSampleEncoding.IeeeFloat));
        float[] mono = CreateSine(48_000, 220, 1);
        float[] stereo = mono.SelectMany(sample => new[] { sample, sample }).ToArray();
        byte[] bytes = EncodeFloats(stereo);
        List<AudioFrame> frames = [];

        int offset = 0;
        int[] blockSizes = [1, 7, 31, 997, 4093];
        int blockIndex = 0;
        while (offset < bytes.Length)
        {
            int length = Math.Min(blockSizes[blockIndex++ % blockSizes.Length], bytes.Length - offset);
            frames.AddRange(pipeline.Process(bytes.AsSpan(offset, length)));
            offset += length;
        }

        Assert.IsGreaterThanOrEqualTo(49, frames.Count);
        Assert.IsTrue(frames.All(frame => frame.Pcm.Length == 640));
    }

    [TestMethod]
    public void PipelineSanitizesInvalidFloatingPointSamples()
    {
        AudioConversionPipeline pipeline = new(new AudioInputFormat(16_000, 1, 32, AudioSampleEncoding.IeeeFloat));
        float[] source = Enumerable.Repeat(float.NaN, 320).ToArray();

        IReadOnlyList<AudioFrame> frames = pipeline.Process(EncodeFloats(source));
        Assert.HasCount(1, frames);
        AudioFrame frame = frames[0];

        Assert.AreEqual(0d, frame.Rms);
        Assert.IsTrue(frame.Pcm.All(value => value == 0));
    }

    [TestMethod]
    public void PipelineDiscardsPartialOutputOnStop()
    {
        AudioConversionPipeline pipeline = new(new AudioInputFormat(16_000, 1, 32, AudioSampleEncoding.IeeeFloat));
        pipeline.Process(EncodeFloats(new float[100]));

        pipeline.DiscardRemainder();

        Assert.AreEqual(0, pipeline.PendingOutputSampleCount);
        Assert.AreEqual(0, pipeline.PendingInputByteCount);
    }

    private static float[] CreateSine(int sampleRate, int frequency, int seconds)
    {
        return Enumerable.Range(0, sampleRate * seconds)
            .Select(index => (float)(Math.Sin(2 * Math.PI * frequency * index / sampleRate) * 0.5))
            .ToArray();
    }

    private static byte[] EncodeFloats(float[] samples)
    {
        byte[] bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }
}
