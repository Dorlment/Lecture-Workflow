using System.Buffers;
using System.Threading.Channels;

namespace LectureWorkflow.AudioCompanion.Core;

public interface IAudioBufferPool
{
    byte[] Rent(int minimumLength);

    void Return(byte[] buffer);
}

public sealed class SharedAudioBufferPool : IAudioBufferPool
{
    public static SharedAudioBufferPool Instance { get; } = new();

    private SharedAudioBufferPool()
    {
    }

    public byte[] Rent(int minimumLength) => ArrayPool<byte>.Shared.Rent(minimumLength);

    public void Return(byte[] buffer) => ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
}

public sealed class PooledAudioChunk : IDisposable
{
    private readonly IAudioBufferPool pool;
    private byte[]? buffer;

    public PooledAudioChunk(IAudioBufferPool pool, byte[] buffer, int length)
    {
        ArgumentNullException.ThrowIfNull(pool);
        ArgumentNullException.ThrowIfNull(buffer);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);

        if (length > buffer.Length)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }

        this.pool = pool;
        this.buffer = buffer;
        Length = length;
    }

    public int Length { get; }

    public ReadOnlyMemory<byte> Memory
    {
        get
        {
            byte[] activeBuffer = Volatile.Read(ref buffer)
                ?? throw new ObjectDisposedException(nameof(PooledAudioChunk));
            return activeBuffer.AsMemory(0, Length);
        }
    }

    public void Dispose()
    {
        byte[]? ownedBuffer = Interlocked.Exchange(ref buffer, null);
        if (ownedBuffer is not null)
        {
            pool.Return(ownedBuffer);
        }
    }
}

public sealed class BoundedAudioChunkQueue : IAsyncDisposable
{
    public const int DefaultChunkCapacity = 64;
    public const long DefaultByteCapacity = 4L * 1024 * 1024;

    private readonly Channel<PooledAudioChunk> channel;
    private readonly long byteCapacity;
    private long queuedBytes;
    private int completed;

    public BoundedAudioChunkQueue(
        int chunkCapacity = DefaultChunkCapacity,
        long byteCapacity = DefaultByteCapacity)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(chunkCapacity);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(byteCapacity);

        this.byteCapacity = byteCapacity;
        channel = Channel.CreateBounded<PooledAudioChunk>(new BoundedChannelOptions(chunkCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });
    }

    public long QueuedBytes => Interlocked.Read(ref queuedBytes);

    public bool TryEnqueue(PooledAudioChunk chunk)
    {
        ArgumentNullException.ThrowIfNull(chunk);

        if (Volatile.Read(ref completed) != 0)
        {
            return false;
        }

        long totalBytes = Interlocked.Add(ref queuedBytes, chunk.Length);
        if (totalBytes > byteCapacity)
        {
            Interlocked.Add(ref queuedBytes, -chunk.Length);
            return false;
        }

        if (!channel.Writer.TryWrite(chunk))
        {
            Interlocked.Add(ref queuedBytes, -chunk.Length);
            return false;
        }

        return true;
    }

    public async ValueTask<PooledAudioChunk?> ReadAsync(CancellationToken cancellationToken)
    {
        while (await channel.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (channel.Reader.TryRead(out PooledAudioChunk? chunk))
            {
                Interlocked.Add(ref queuedBytes, -chunk.Length);
                return chunk;
            }
        }

        return null;
    }

    public void Complete()
    {
        if (Interlocked.Exchange(ref completed, 1) == 0)
        {
            channel.Writer.TryComplete();
        }
    }

    public async ValueTask DisposeAsync()
    {
        Complete();
        while (channel.Reader.TryRead(out PooledAudioChunk? chunk))
        {
            Interlocked.Add(ref queuedBytes, -chunk.Length);
            chunk.Dispose();
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
