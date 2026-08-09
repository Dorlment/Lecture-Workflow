using LectureWorkflow.AudioCompanion.Protocol;

namespace LectureWorkflow.AudioCompanion.Windows;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "probe", StringComparison.OrdinalIgnoreCase))
        {
            return await RunProbeAsync().ConfigureAwait(false);
        }

        if (TryParseServerArguments(args, out bool stopOnStdinEof))
        {
            return await RunServerAsync(stopOnStdinEof).ConfigureAwait(false);
        }

        if (args.Length == 1 && string.Equals(args[0], "server-self-test", StringComparison.OrdinalIgnoreCase))
        {
            return await AudioCompanionServerSelfTest.RunAsync(Console.Out, Console.Error).ConfigureAwait(false);
        }

        if (TryParseDevelopmentClientArguments(args, out TimeSpan? runDuration))
        {
            string? token = await Console.In.ReadLineAsync().ConfigureAwait(false);
            if (token is null || !AudioCompanionTokenDigest.IsValidToken(token))
            {
                Console.Error.WriteLine("客户端状态：启动失败；错误码：invalid-token-format");
                return 2;
            }

            try
            {
                return await AudioCompanionDevelopmentClient.RunAsync(
                    token,
                    Console.Out,
                    Console.Error,
                    runDuration).ConfigureAwait(false);
            }
            finally
            {
                token = null;
            }
        }

        Console.Error.WriteLine("用法：");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- probe");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server --token-stdin");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server --token-stdin --stop-on-stdin-eof");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server-self-test");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server-test-client --token-stdin");
        Console.Error.WriteLine("  dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server-test-client --token-stdin --duration-seconds 10");
        return 2;
    }

    private static async Task<int> RunProbeAsync()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("捕获状态：失败；错误码：unsupported-platform");
            return 1;
        }

        using CancellationTokenSource cancellation = InstallCancellationHandler(out ConsoleCancelEventHandler handler);
        using ConsoleProbeReporter reporter = new(Console.Out);
        await using AudioProbeSession session = new(new WasapiLoopbackCaptureBackendFactory(), reporter);
        try
        {
            await session.StartAsync(cancellation.Token).ConfigureAwait(false);
            await session.Completion.ConfigureAwait(false);
            return session.State == AudioProbeSessionState.Stopped ? 0 : 1;
        }
        catch
        {
            return 1;
        }
        finally
        {
            Console.CancelKeyPress -= handler;
        }
    }

    private static async Task<int> RunServerAsync(bool stopOnStdinEof)
    {
        string? token = await Console.In.ReadLineAsync().ConfigureAwait(false);
        if (token is null || !AudioCompanionTokenDigest.IsValidToken(token))
        {
            Console.Error.WriteLine("服务状态：启动失败；错误码：invalid-token-format");
            return 2;
        }

        AudioCompanionTokenDigest digest;
        try
        {
            digest = AudioCompanionTokenDigest.Create(token);
        }
        catch
        {
            Console.Error.WriteLine("服务状态：启动失败；错误码：invalid-token-format");
            return 2;
        }
        finally
        {
            token = null;
        }

        using CancellationTokenSource cancellation = InstallCancellationHandler(out ConsoleCancelEventHandler handler);
        Task<string>? stdinLifetime = null;
        await using AudioCompanionServerHost host = new(digest, new WasapiServerCaptureFactory());
        try
        {
            await host.StartAsync(cancellation.Token).ConfigureAwait(false);
            stdinLifetime = stopOnStdinEof
                ? MonitorStdinEofAsync(Console.In, cancellation.Token)
                : null;
            Console.Out.WriteLine("服务状态：运行中；端点：ws://127.0.0.1:43127/v1/audio");
            Task shutdown = host.WaitForShutdownAsync(cancellation.Token);
            await WaitForServerLifetimeAsync(shutdown, stdinLifetime, cancellation).ConfigureAwait(false);
            return 0;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            Console.Out.WriteLine("服务状态：已停止；资源已释放");
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("服务状态：失败；错误码：server-failed");
            return 1;
        }
        finally
        {
            cancellation.Cancel();
            if (stdinLifetime is not null)
            {
                try
                {
                    await stdinLifetime.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                }
            }

            Console.CancelKeyPress -= handler;
        }
    }

    internal static Task<string> MonitorStdinEofAsync(
        TextReader input,
        CancellationToken cancellationToken) =>
        Task.Run(
            async () => await input.ReadToEndAsync(cancellationToken).ConfigureAwait(false),
            CancellationToken.None);

    internal static bool TryParseServerArguments(string[] args, out bool stopOnStdinEof)
    {
        stopOnStdinEof = args.Length == 3
            && string.Equals(args[2], "--stop-on-stdin-eof", StringComparison.Ordinal);
        return args.Length is 2 or 3
            && string.Equals(args[0], "server", StringComparison.OrdinalIgnoreCase)
            && string.Equals(args[1], "--token-stdin", StringComparison.Ordinal)
            && (args.Length == 2 || stopOnStdinEof);
    }

    internal static bool TryParseDevelopmentClientArguments(string[] args, out TimeSpan? runDuration)
    {
        runDuration = null;
        if (args.Length == 2
            && string.Equals(args[0], "server-test-client", StringComparison.OrdinalIgnoreCase)
            && string.Equals(args[1], "--token-stdin", StringComparison.Ordinal))
        {
            return true;
        }

        if (args.Length != 4
            || !string.Equals(args[0], "server-test-client", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(args[1], "--token-stdin", StringComparison.Ordinal)
            || !string.Equals(args[2], "--duration-seconds", StringComparison.Ordinal)
            || args[3].Length == 0
            || !args[3].All(char.IsAsciiDigit)
            || !int.TryParse(args[3], out int seconds)
            || seconds is < 1 or > 600)
        {
            return false;
        }

        runDuration = TimeSpan.FromSeconds(seconds);
        return true;
    }

    internal static async Task WaitForServerLifetimeAsync(
        Task shutdown,
        Task<string>? stdinLifetime,
        CancellationTokenSource cancellation)
    {
        if (stdinLifetime is not null)
        {
            Task completed = await Task.WhenAny(shutdown, stdinLifetime).ConfigureAwait(false);
            if (completed == stdinLifetime)
            {
                await stdinLifetime.ConfigureAwait(false);
                cancellation.Cancel();
            }
        }

        await shutdown.ConfigureAwait(false);
    }

    private static CancellationTokenSource InstallCancellationHandler(out ConsoleCancelEventHandler handler)
    {
        CancellationTokenSource cancellation = new();
        handler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += handler;
        return cancellation;
    }
}
