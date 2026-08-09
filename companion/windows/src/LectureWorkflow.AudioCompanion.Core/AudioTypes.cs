namespace LectureWorkflow.AudioCompanion.Core;

public enum AudioSampleEncoding
{
    PcmInteger,
    IeeeFloat,
}

public sealed record AudioInputFormat(
    int SampleRate,
    int Channels,
    int BitsPerSample,
    AudioSampleEncoding Encoding,
    int? ValidBitsPerSample = null)
{
    public int BytesPerSample => BitsPerSample / 8;

    public int BlockAlign => checked(BytesPerSample * Channels);

    public int EffectiveBitsPerSample => ValidBitsPerSample ?? BitsPerSample;

    public void Validate()
    {
        if (SampleRate <= 0)
        {
            throw new AudioProbeException(AudioProbeErrorCode.UnsupportedInputFormat);
        }

        if (Channels <= 0 || Channels > 32)
        {
            throw new AudioProbeException(AudioProbeErrorCode.UnsupportedInputFormat);
        }

        bool supported = Encoding switch
        {
            AudioSampleEncoding.IeeeFloat => BitsPerSample == 32 && EffectiveBitsPerSample == 32,
            AudioSampleEncoding.PcmInteger => BitsPerSample is 16 or 24 or 32
                && EffectiveBitsPerSample >= 2
                && EffectiveBitsPerSample <= BitsPerSample,
            _ => false,
        };

        if (!supported)
        {
            throw new AudioProbeException(AudioProbeErrorCode.UnsupportedInputFormat);
        }
    }
}

public sealed record AudioFrame(
    long Sequence,
    long StartSampleIndex,
    double OffsetMs,
    byte[] Pcm,
    double Rms);

public enum AudioProbeErrorCode
{
    UnsupportedPlatform,
    DefaultDeviceUnavailable,
    CaptureInitializationFailed,
    UnsupportedInputFormat,
    CaptureBackpressure,
    DefaultDeviceChanged,
    DeviceInvalidated,
    CaptureFailed,
}

public sealed class AudioProbeException : Exception
{
    public AudioProbeException(AudioProbeErrorCode code)
        : base(ToStableCode(code))
    {
        Code = code;
    }

    public AudioProbeException(AudioProbeErrorCode code, Exception innerException)
        : base(ToStableCode(code), innerException)
    {
        Code = code;
    }

    public AudioProbeErrorCode Code { get; }

    public static string ToStableCode(AudioProbeErrorCode code) => code switch
    {
        AudioProbeErrorCode.UnsupportedPlatform => "unsupported-platform",
        AudioProbeErrorCode.DefaultDeviceUnavailable => "default-device-unavailable",
        AudioProbeErrorCode.CaptureInitializationFailed => "capture-initialization-failed",
        AudioProbeErrorCode.UnsupportedInputFormat => "unsupported-input-format",
        AudioProbeErrorCode.CaptureBackpressure => "capture-backpressure",
        AudioProbeErrorCode.DefaultDeviceChanged => "default-device-changed",
        AudioProbeErrorCode.DeviceInvalidated => "device-invalidated",
        AudioProbeErrorCode.CaptureFailed => "capture-failed",
        _ => "capture-failed",
    };
}
