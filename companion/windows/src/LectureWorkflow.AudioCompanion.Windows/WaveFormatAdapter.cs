using LectureWorkflow.AudioCompanion.Core;
using NAudio.Wave;

namespace LectureWorkflow.AudioCompanion.Windows;

public static class WaveFormatAdapter
{
    public static AudioInputFormat ToInputFormat(WaveFormat waveFormat)
    {
        ArgumentNullException.ThrowIfNull(waveFormat);

        WaveFormat normalized = waveFormat is WaveFormatExtensible extensible
            ? extensible.ToStandardWaveFormat()
            : waveFormat;

        AudioSampleEncoding encoding = normalized.Encoding switch
        {
            WaveFormatEncoding.Pcm => AudioSampleEncoding.PcmInteger,
            WaveFormatEncoding.IeeeFloat => AudioSampleEncoding.IeeeFloat,
            _ => throw new AudioProbeException(AudioProbeErrorCode.UnsupportedInputFormat),
        };

        AudioInputFormat format = new(
            normalized.SampleRate,
            normalized.Channels,
            normalized.BitsPerSample,
            encoding);
        format.Validate();
        return format;
    }
}
