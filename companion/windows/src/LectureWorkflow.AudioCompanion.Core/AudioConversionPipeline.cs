using NAudio.Wave.SampleProviders;

namespace LectureWorkflow.AudioCompanion.Core;

public sealed class AudioConversionPipeline
{
    private readonly AudioInputFormat inputFormat;
    private readonly StreamingAudioDecoder decoder;
    private readonly BufferedMonoSampleProvider sampleSource;
    private readonly WdlResamplingSampleProvider resampler;
    private readonly FixedFrameAssembler frameAssembler = new();
    private readonly float[] resampleBuffer = new float[4096];

    public AudioConversionPipeline(AudioInputFormat inputFormat)
    {
        ArgumentNullException.ThrowIfNull(inputFormat);
        inputFormat.Validate();
        this.inputFormat = inputFormat;
        decoder = new StreamingAudioDecoder(inputFormat);
        sampleSource = new BufferedMonoSampleProvider(inputFormat.SampleRate);
        resampler = new WdlResamplingSampleProvider(sampleSource, FixedFrameAssembler.TargetSampleRate);
    }

    public int PendingInputByteCount => decoder.PendingByteCount;

    public int PendingOutputSampleCount => frameAssembler.PendingSampleCount;

    public IReadOnlyList<AudioFrame> Process(ReadOnlySpan<byte> input)
    {
        float[] interleaved = decoder.Decode(input);
        if (interleaved.Length == 0)
        {
            return [];
        }

        float[] mono = AudioSampleProcessing.DownmixToMono(interleaved, inputFormat.Channels);
        sampleSource.Add(mono);

        List<AudioFrame> frames = [];
        while (sampleSource.AvailableSamples > 0)
        {
            int read = resampler.Read(resampleBuffer, 0, resampleBuffer.Length);
            if (read <= 0)
            {
                break;
            }

            frames.AddRange(frameAssembler.Add(resampleBuffer.AsSpan(0, read)));
        }

        return frames;
    }

    public void DiscardRemainder()
    {
        decoder.Reset();
        frameAssembler.DiscardRemainder();
    }
}
