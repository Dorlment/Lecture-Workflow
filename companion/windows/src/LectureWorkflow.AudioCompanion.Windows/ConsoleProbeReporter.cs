using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class ConsoleProbeReporter : IProbeReporter, IDisposable
{
    private readonly object sync = new();
    private readonly TextWriter output;
    private readonly Timer timer;
    private AudioProbeSessionState state = AudioProbeSessionState.Idle;
    private AudioInputFormat? format;
    private long frameCount;
    private double rms;
    private long lastFrameTimestamp;
    private AudioProbeErrorCode? error;
    private int disposed;

    public ConsoleProbeReporter(TextWriter output)
    {
        this.output = output ?? throw new ArgumentNullException(nameof(output));
        timer = new Timer(static state => ((ConsoleProbeReporter)state!).Render(), this, Timeout.Infinite, Timeout.Infinite);
    }

    public void ReportStarting()
    {
        lock (sync)
        {
            state = AudioProbeSessionState.Starting;
            output.WriteLine("捕获状态：正在启动");
        }
    }

    public void ReportCapturing(AudioInputFormat inputFormat)
    {
        lock (sync)
        {
            format = inputFormat;
            state = AudioProbeSessionState.Capturing;
            output.WriteLine($"捕获状态：运行中；输入：{inputFormat.SampleRate} Hz，{inputFormat.Channels} 声道");
            timer.Change(TimeSpan.Zero, TimeSpan.FromMilliseconds(500));
        }
    }

    public void ReportFrame(long currentFrameCount, double currentRms)
    {
        Interlocked.Exchange(ref frameCount, currentFrameCount);
        Interlocked.Exchange(ref rms, Math.Clamp(currentRms, 0d, 1d));
        Interlocked.Exchange(ref lastFrameTimestamp, Environment.TickCount64);
    }

    public void ReportStopping()
    {
        lock (sync)
        {
            state = AudioProbeSessionState.Stopping;
            timer.Change(Timeout.Infinite, Timeout.Infinite);
            output.WriteLine("捕获状态：正在停止");
        }
    }

    public void ReportStopped(long finalFrameCount)
    {
        lock (sync)
        {
            state = AudioProbeSessionState.Stopped;
            output.WriteLine($"捕获状态：已停止；已处理帧数：{finalFrameCount}；设备资源已释放");
        }
    }

    public void ReportError(AudioProbeErrorCode errorCode)
    {
        lock (sync)
        {
            error = errorCode;
            state = AudioProbeSessionState.Faulted;
            timer.Change(Timeout.Infinite, Timeout.Infinite);
            output.WriteLine($"捕获状态：失败；错误码：{AudioProbeException.ToStableCode(errorCode)}");
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0)
        {
            timer.Dispose();
        }
    }

    private void Render()
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            return;
        }

        AudioInputFormat? currentFormat;
        AudioProbeSessionState currentState;
        AudioProbeErrorCode? currentError;
        lock (sync)
        {
            currentFormat = format;
            currentState = state;
            currentError = error;
        }

        if (currentState != AudioProbeSessionState.Capturing || currentFormat is null || currentError is not null)
        {
            return;
        }

        long lastFrame = Interlocked.Read(ref lastFrameTimestamp);
        double currentRms = Environment.TickCount64 - lastFrame > 1000
            ? 0
            : Interlocked.CompareExchange(ref rms, 0, 0);
        output.WriteLine(
            $"捕获状态：运行中；输入：{currentFormat.SampleRate} Hz/{currentFormat.Channels} 声道；"
            + $"帧数：{Interlocked.Read(ref frameCount)}；RMS：{Math.Round(currentRms * 100)}%");
    }
}
