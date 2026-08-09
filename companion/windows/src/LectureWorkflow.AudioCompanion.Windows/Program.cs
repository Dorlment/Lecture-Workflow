namespace LectureWorkflow.AudioCompanion.Windows;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length != 1 || !string.Equals(args[0], "probe", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("用法：dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- probe");
            return 2;
        }

        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("捕获状态：失败；错误码：unsupported-platform");
            return 1;
        }

        using CancellationTokenSource cancellation = new();
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += cancelHandler;

        using ConsoleProbeReporter reporter = new(Console.Out);
        await using AudioProbeSession session = new(new WasapiLoopbackCaptureBackendFactory(), reporter);

        try
        {
            await session.StartAsync(cancellation.Token).ConfigureAwait(false);
            await session.Completion.ConfigureAwait(false);
            return session.State == AudioProbeSessionState.Stopped ? 0 : 1;
        }
        catch (Exception)
        {
            return 1;
        }
        finally
        {
            Console.CancelKeyPress -= cancelHandler;
        }
    }
}
