using System.Net;
using System.Net.WebSockets;
using LectureWorkflow.AudioCompanion.Protocol;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class AudioCompanionServerHost : IAsyncDisposable
{
    public const int Port = 43127;
    public const string Path = "/v1/audio";

    private readonly AudioCompanionTokenDigest tokenDigest;
    private readonly IAudioServerCaptureFactory captureFactory;
    private readonly ExclusiveLease connectionLease = new();
    private readonly ExclusiveLease captureLease = new();
    private readonly object lifecycleLock = new();
    private WebApplication? application;
    private int disposed;
    private int tokenCleared;

    public AudioCompanionServerHost(
        AudioCompanionTokenDigest tokenDigest,
        IAudioServerCaptureFactory captureFactory)
    {
        this.tokenDigest = tokenDigest ?? throw new ArgumentNullException(nameof(tokenDigest));
        this.captureFactory = captureFactory ?? throw new ArgumentNullException(nameof(captureFactory));
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        WebApplication app;
        lock (lifecycleLock)
        {
            if (application is not null)
            {
                throw new InvalidOperationException("The audio companion server is already started.");
            }

            WebApplicationBuilder builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
            {
                Args = [],
                ApplicationName = typeof(AudioCompanionServerHost).Assembly.FullName,
            });
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, Port));
            builder.Services.AddRouting();
            app = builder.Build();
            app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.Zero });
            app.Run(HandleRequestAsync);
            application = app;
        }

        try
        {
            await app.StartAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            lock (lifecycleLock)
            {
                application = null;
            }

            await app.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task WaitForShutdownAsync(CancellationToken cancellationToken) =>
        await (application ?? throw new InvalidOperationException("The server has not started."))
            .WaitForShutdownAsync(cancellationToken)
            .ConfigureAwait(false);

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        WebApplication? app;
        lock (lifecycleLock)
        {
            app = application;
            application = null;
        }

        try
        {
            if (app is not null)
            {
                await app.StopAsync(cancellationToken).ConfigureAwait(false);
                await app.DisposeAsync().ConfigureAwait(false);
            }
        }
        finally
        {
            ClearExpectedTokenDigest();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await StopAsync().ConfigureAwait(false);
        }
        finally
        {
            ClearExpectedTokenDigest();
        }
    }

    private async Task HandleRequestAsync(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method)
            || context.Request.Path != Path
            || context.Request.QueryString.HasValue
            || context.Connection.RemoteIpAddress is null
            || !IPAddress.IsLoopback(context.Connection.RemoteIpAddress)
            || !context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        WebSocket nativeSocket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
        SystemAudioCompanionSocket socket = new(nativeSocket);
        IDisposable? lease = connectionLease.TryAcquire();
        if (lease is null)
        {
            await RejectBusyAsync(socket, context.RequestAborted).ConfigureAwait(false);
            return;
        }

        using (lease)
        await using (AudioCompanionConnection connection = new(
            socket,
            tokenDigest,
            captureFactory,
            captureLease))
        {
            await connection.RunAsync(context.RequestAborted).ConfigureAwait(false);
        }
    }

    private static async Task RejectBusyAsync(IAudioCompanionSocket socket, CancellationToken cancellationToken)
    {
        try
        {
            using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            byte[] error = AudioCompanionControlCodec.Error("BUSY", "音频助手已有活动连接。", true);
            await socket.SendAsync(error, WebSocketMessageType.Text, timeout.Token).ConfigureAwait(false);
            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "busy", timeout.Token).ConfigureAwait(false);
        }
        catch
        {
        }
        finally
        {
            await socket.DisposeAsync().ConfigureAwait(false);
        }
    }

    private void ClearExpectedTokenDigest()
    {
        if (Interlocked.Exchange(ref tokenCleared, 1) == 0)
        {
            tokenDigest.Dispose();
        }
    }
}
