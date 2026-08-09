using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class FixedFrameAssemblerTests
{
    [TestMethod]
    public void EmitsExactlyTwentyMillisecondFrames()
    {
        FixedFrameAssembler assembler = new();

        IReadOnlyList<AudioFrame> frames = assembler.Add(new float[320]);
        Assert.HasCount(1, frames);
        AudioFrame frame = frames[0];

        Assert.HasCount(640, frame.Pcm);
        Assert.AreEqual(0L, frame.Sequence);
        Assert.AreEqual(0d, frame.OffsetMs);
    }

    [TestMethod]
    public void RetainsRemainderAcrossCalls()
    {
        FixedFrameAssembler assembler = new();

        Assert.IsEmpty(assembler.Add(new float[100]));
        Assert.AreEqual(100, assembler.PendingSampleCount);
        Assert.HasCount(1, assembler.Add(new float[220]));
        Assert.AreEqual(0, assembler.PendingSampleCount);
    }

    [TestMethod]
    public void EmitsMonotonicSequenceAndSampleOffsets()
    {
        FixedFrameAssembler assembler = new();

        IReadOnlyList<AudioFrame> frames = assembler.Add(new float[960]);

        Assert.HasCount(3, frames);
        Assert.AreEqual(0L, frames[0].Sequence);
        Assert.AreEqual(1L, frames[1].Sequence);
        Assert.AreEqual(2L, frames[2].Sequence);
        Assert.AreEqual(20d, frames[1].OffsetMs);
        Assert.AreEqual(40d, frames[2].OffsetMs);
        Assert.AreEqual(640L, frames[2].StartSampleIndex);
    }

    [TestMethod]
    public void CalculatesRmsWithoutExposingSamples()
    {
        FixedFrameAssembler assembler = new();
        float[] samples = Enumerable.Repeat(0.5f, 320).ToArray();

        IReadOnlyList<AudioFrame> frames = assembler.Add(samples);
        Assert.HasCount(1, frames);
        AudioFrame frame = frames[0];

        Assert.AreEqual(0.5d, frame.Rms, 0.0001d);
    }

    [TestMethod]
    public void DiscardRemainderDoesNotEmitPartialFrame()
    {
        FixedFrameAssembler assembler = new();
        assembler.Add(new float[319]);

        assembler.DiscardRemainder();

        Assert.AreEqual(0, assembler.PendingSampleCount);
    }
}
