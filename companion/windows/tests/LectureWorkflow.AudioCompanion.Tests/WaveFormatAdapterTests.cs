using LectureWorkflow.AudioCompanion.Core;
using LectureWorkflow.AudioCompanion.Windows;
using NAudio.Wave;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class WaveFormatAdapterTests
{
    [TestMethod]
    public void MapsPcmWaveFormat()
    {
        AudioInputFormat format = WaveFormatAdapter.ToInputFormat(new WaveFormat(48_000, 16, 2));

        Assert.AreEqual(48_000, format.SampleRate);
        Assert.AreEqual(2, format.Channels);
        Assert.AreEqual(16, format.BitsPerSample);
        Assert.AreEqual(AudioSampleEncoding.PcmInteger, format.Encoding);
    }

    [TestMethod]
    public void MapsFloatWaveFormat()
    {
        AudioInputFormat format = WaveFormatAdapter.ToInputFormat(WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2));

        Assert.AreEqual(AudioSampleEncoding.IeeeFloat, format.Encoding);
        Assert.AreEqual(32, format.BitsPerSample);
    }

    [TestMethod]
    public void MapsExtensibleFloatWaveFormat()
    {
        WaveFormatExtensible extensible = new(48_000, 32, 2, 0);

        AudioInputFormat format = WaveFormatAdapter.ToInputFormat(extensible);

        Assert.AreEqual(AudioSampleEncoding.IeeeFloat, format.Encoding);
    }

    [TestMethod]
    public void RejectsUnsupportedEncoding()
    {
        WaveFormat unsupported = WaveFormat.CreateCustomFormat(WaveFormatEncoding.Adpcm, 48_000, 2, 1, 1, 4);

        AudioProbeException exception = Assert.ThrowsExactly<AudioProbeException>(() =>
            WaveFormatAdapter.ToInputFormat(unsupported));

        Assert.AreEqual(AudioProbeErrorCode.UnsupportedInputFormat, exception.Code);
    }
}
