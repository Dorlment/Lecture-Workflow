using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class AudioProbeSession : IAsyncDisposable
{
    private readonly IAudioCaptureBackendFactory backendFactory;
    private readonly IProbeReporter reporter;
    private readonly IAudioBufferPool bufferPool;
    private readonly int queueChunkCapacity;
    private readonly long queueByteCapacity;
    private readonly IAudioFrameSink? frameSink;
    private readonly object lifecycleLock = new();
    private CancellationTokenSource? sessionCancellation;
    private CancellationTokenRegistration externalCancellationRegistration;
    private IAudioCaptureBackend? backend;
    private BoundedAudioChunkQueue? queue;
    private Task? consumerTask;
    private Task? lifecycleTask;
    private TaskCompletionSource<AudioProbeErrorCode?>? completion;
    private long frameCount;
    private int disposed;

    public AudioProbeSession(
        IAudioCaptureBackendFactory backendFactory,
        IProbeReporter reporter,
        IAudioBufferPool? bufferPool = null,
        int queueChunkCapacity = BoundedAudioChunkQueue.DefaultChunkCapacity,
        long queueByteCapacity = BoundedAudioChunkQueue.DefaultByteCapacity,
        IAudioFrameSink? frameSink = null)
    {
        this.backendFactory = backendFactory ?? throw new ArgumentNullException(nameof(backendFactory));
        this.reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
        this.bufferPool = bufferPool ?? SharedAudioBufferPool.Instance;
        this.queueChunkCapacity = queueChunkCapacity;
        this.queueByteCapacity = queueByteCapacity;
        this.frameSink = frameSink;
    }

    public AudioProbeSessionState State { get; private set; } = AudioProbeSessionState.Idle;

    public long FrameCount => Interlocked.Read(ref frameCount);

    public Task Completion => lifecycleTask ?? Task.CompletedTask;

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (lifecycleLock)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            if (State != AudioProbeSessionState.Idle)
            {
                throw new InvalidOperationException("The audio probe session has already been started.");
            }

            State = AudioProbeSessionState.Starting;
            reporter.ReportStarting();

            try
            {
                backend = backendFactory.Create();
                backend.InputFormat.Validate();
                queue = new BoundedAudioChunkQueue(queueChunkCapacity, queueByteCapacity);
                sessionCancellation = new CancellationTokenSource();
                completion = new TaskCompletionSource<AudioProbeErrorCode?>(TaskCreationOptions.RunContinuationsAsynchronously);
                externalCancellationRegistration = cancellationToken.Register(
                    static state => ((TaskCompletionSource<AudioProbeErrorCode?>)state!).TrySetResult(null),
                    completion);

                Subscribe(backend);
                AudioConversionPipeline pipeline = new(backend.InputFormat);
                backend.Start();
                consumerTask = ConsumeAsync(queue, pipeline, sessionCancellation.Token);
                State = AudioProbeSessionState.Capturing;
                reporter.ReportCapturing(backend.InputFormat);
                lifecycleTask = CompleteLifecycleAsync();
                return Task.CompletedTask;
            }
            catch (Exception exception)
            {
                AudioProbeException probeException = exception as AudioProbeException
                    ?? new AudioProbeException(AudioProbeErrorCode.CaptureInitializationFailed, exception);
                State = AudioProbeSessionState.Faulted;
                reporter.ReportError(probeException.Code);
                CleanupSynchronous();
                throw probeException;
            }
        }
    }

    public async Task StopAsync()
    {
        Task? activeLifecycle;
        lock (lifecycleLock)
        {
            completion?.TrySetResult(null);
            activeLifecycle = lifecycleTask;
        }

        if (activeLifecycle is not null)
        {
            await activeLifecycle.ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        await StopAsync().ConfigureAwait(false);
        CleanupSynchronous();
        State = AudioProbeSessionState.Disposed;
    }

    private async Task CompleteLifecycleAsync()
    {
        IAudioCaptureBackend activeBackend = backend
            ?? throw new InvalidOperationException("Capture backend is unavailable.");
        BoundedAudioChunkQueue activeQueue = queue
            ?? throw new InvalidOperationException("Capture queue is unavailable.");
        CancellationTokenSource activeCancellation = sessionCancellation
            ?? throw new InvalidOperationException("Capture cancellation source is unavailable.");
        Task activeConsumer = consumerTask
            ?? throw new InvalidOperationException("Capture consumer is unavailable.");
        AudioProbeErrorCode? error = await completion!.Task.ConfigureAwait(false);
        State = AudioProbeSessionState.Stopping;
        reporter.ReportStopping();

        Unsubscribe(activeBackend);
        try
        {
            activeBackend.Stop();
        }
        catch
        {
            error ??= AudioProbeErrorCode.CaptureFailed;
        }

        activeQueue.Complete();
        activeCancellation.Cancel();
        try
        {
            await activeConsumer.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown path.
        }
        catch
        {
            error ??= AudioProbeErrorCode.CaptureFailed;
        }

        await activeQueue.DisposeAsync().ConfigureAwait(false);
        activeBackend.Dispose();
        externalCancellationRegistration.Dispose();
        activeCancellation.Dispose();

        queue = null;
        backend = null;
        sessionCancellation = null;
        consumerTask = null;

        if (error is null)
        {
            State = AudioProbeSessionState.Stopped;
            reporter.ReportStopped(FrameCount);
        }
        else
        {
            State = AudioProbeSessionState.Faulted;
            reporter.ReportError(error.Value);
        }
    }

    private async Task ConsumeAsync(
        BoundedAudioChunkQueue activeQueue,
        AudioConversionPipeline pipeline,
        CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                PooledAudioChunk? chunk = await activeQueue.ReadAsync(cancellationToken).ConfigureAwait(false);
                if (chunk is null)
                {
                    break;
                }

                using (chunk)
                {
                    IReadOnlyList<AudioFrame> frames = pipeline.Process(chunk.Memory.Span);
                    double batchDurationMs = chunk.Length * 1000d
                        / pipeline.InputBlockAlign
                        / pipeline.InputSampleRate;
                    long batchDurationTicks = checked((long)Math.Round(
                        batchDurationMs * System.Diagnostics.Stopwatch.Frequency / 1000d));
                    long estimatedBatchStart = Math.Max(0, chunk.CaptureTimestamp - batchDurationTicks);
                    for (int index = 0; index < frames.Count; index++)
                    {
                        AudioFrame frame = frames[index];
                        long count = Interlocked.Increment(ref frameCount);
                        reporter.ReportFrame(count, frame.Rms);
                        long estimatedFrameTimestamp = checked(estimatedBatchStart
                            + (long)Math.Round(index * 20d * System.Diagnostics.Stopwatch.Frequency / 1000d));
                        bool transferred = false;
                        try
                        {
                            transferred = frameSink?.TryAccept(
                                frame,
                                new AudioFrameCaptureMetadata(estimatedFrameTimestamp, batchDurationMs)) ?? false;
                        }
                        finally
                        {
                            if (!transferred)
                            {
                                System.Security.Cryptography.CryptographicOperations.ZeroMemory(frame.Pcm);
                            }
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            completion?.TrySetResult(AudioProbeErrorCode.CaptureFailed);
        }
        finally
        {
            pipeline.DiscardRemainder();
        }
    }

    private void OnDataAvailable(object? sender, AudioDataAvailableEventArgs eventArgs)
    {
        BoundedAudioChunkQueue? activeQueue = queue;
        if (activeQueue is null || eventArgs.Count == 0)
        {
            return;
        }

        byte[] rented = bufferPool.Rent(eventArgs.Count);
        PooledAudioChunk? chunk = null;
        bool ownershipTransferred = false;
        try
        {
            Buffer.BlockCopy(eventArgs.Buffer, 0, rented, 0, eventArgs.Count);
            chunk = new PooledAudioChunk(bufferPool, rented, eventArgs.Count, eventArgs.CaptureTimestamp);
            if (activeQueue.TryEnqueue(chunk))
            {
                ownershipTransferred = true;
                chunk = null;
                return;
            }

            completion?.TrySetResult(AudioProbeErrorCode.CaptureBackpressure);
        }
        catch
        {
            completion?.TrySetResult(AudioProbeErrorCode.CaptureFailed);
        }
        finally
        {
            if (!ownershipTransferred && chunk is not null)
            {
                chunk.Dispose();
            }
            else if (!ownershipTransferred)
            {
                bufferPool.Return(rented);
            }
        }
    }

    private void OnCaptureStopped(object? sender, AudioCaptureStoppedEventArgs eventArgs)
    {
        completion?.TrySetResult(eventArgs.Exception is null ? null : AudioProbeErrorCode.CaptureFailed);
    }

    private void OnDefaultDeviceChanged(object? sender, EventArgs eventArgs)
    {
        completion?.TrySetResult(AudioProbeErrorCode.DefaultDeviceChanged);
    }

    private void OnDeviceInvalidated(object? sender, EventArgs eventArgs)
    {
        completion?.TrySetResult(AudioProbeErrorCode.DeviceInvalidated);
    }

    private void Subscribe(IAudioCaptureBackend activeBackend)
    {
        activeBackend.DataAvailable += OnDataAvailable;
        activeBackend.CaptureStopped += OnCaptureStopped;
        activeBackend.DefaultDeviceChanged += OnDefaultDeviceChanged;
        activeBackend.DeviceInvalidated += OnDeviceInvalidated;
    }

    private void Unsubscribe(IAudioCaptureBackend activeBackend)
    {
        activeBackend.DataAvailable -= OnDataAvailable;
        activeBackend.CaptureStopped -= OnCaptureStopped;
        activeBackend.DefaultDeviceChanged -= OnDefaultDeviceChanged;
        activeBackend.DeviceInvalidated -= OnDeviceInvalidated;
    }

    private void CleanupSynchronous()
    {
        if (backend is not null)
        {
            Unsubscribe(backend);
            backend.Dispose();
            backend = null;
        }

        if (queue is not null)
        {
            queue.DisposeAsync().AsTask().GetAwaiter().GetResult();
            queue = null;
        }

        externalCancellationRegistration.Dispose();
        sessionCancellation?.Dispose();
        sessionCancellation = null;
    }
}
