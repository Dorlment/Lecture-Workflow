using LectureWorkflow.AudioCompanion.Core;

namespace LectureWorkflow.AudioCompanion.Tests;

[TestClass]
public sealed class AudioBufferingTests
{
    [TestMethod]
    public void PooledChunkReturnsBufferExactlyOnce()
    {
        CountingBufferPool pool = new();
        PooledAudioChunk chunk = new(pool, pool.Rent(32), 32);

        chunk.Dispose();
        chunk.Dispose();

        Assert.AreEqual(1, pool.RentCount);
        Assert.AreEqual(1, pool.ReturnCount);
    }

    [TestMethod]
    public async Task QueueRejectsChunkWhenChunkCapacityIsReached()
    {
        CountingBufferPool pool = new();
        await using BoundedAudioChunkQueue queue = new(chunkCapacity: 1, byteCapacity: 1024);
        using PooledAudioChunk first = CreateChunk(pool, 16);
        using PooledAudioChunk second = CreateChunk(pool, 16);

        Assert.IsTrue(queue.TryEnqueue(first));
        Assert.IsFalse(queue.TryEnqueue(second));

        second.Dispose();
        Assert.AreEqual(1, pool.ReturnCount);
    }

    [TestMethod]
    public async Task QueueRejectsChunkWhenByteBudgetIsExceeded()
    {
        CountingBufferPool pool = new();
        await using BoundedAudioChunkQueue queue = new(chunkCapacity: 4, byteCapacity: 20);
        using PooledAudioChunk first = CreateChunk(pool, 16);
        using PooledAudioChunk second = CreateChunk(pool, 8);

        Assert.IsTrue(queue.TryEnqueue(first));
        Assert.IsFalse(queue.TryEnqueue(second));
        Assert.AreEqual(16L, queue.QueuedBytes);

        second.Dispose();
        Assert.AreEqual(1, pool.ReturnCount);
    }

    [TestMethod]
    public async Task ReadTransfersChunkAndReducesByteBudget()
    {
        CountingBufferPool pool = new();
        await using BoundedAudioChunkQueue queue = new(chunkCapacity: 2, byteCapacity: 100);
        PooledAudioChunk original = CreateChunk(pool, 24);
        Assert.IsTrue(queue.TryEnqueue(original));

        PooledAudioChunk? read = await queue.ReadAsync(CancellationToken.None);

        Assert.AreSame(original, read);
        Assert.AreEqual(0L, queue.QueuedBytes);
        read!.Dispose();
    }

    [TestMethod]
    public async Task DisposeReturnsAllQueuedBuffersExactlyOnce()
    {
        CountingBufferPool pool = new();
        BoundedAudioChunkQueue queue = new(chunkCapacity: 4, byteCapacity: 100);
        Assert.IsTrue(queue.TryEnqueue(CreateChunk(pool, 10)));
        Assert.IsTrue(queue.TryEnqueue(CreateChunk(pool, 10)));

        await queue.DisposeAsync();
        await queue.DisposeAsync();

        Assert.AreEqual(2, pool.ReturnCount);
    }

    [TestMethod]
    public async Task CompletedQueueRejectsNewChunksWithoutTakingOwnership()
    {
        CountingBufferPool pool = new();
        await using BoundedAudioChunkQueue queue = new();
        using PooledAudioChunk chunk = CreateChunk(pool, 10);
        queue.Complete();

        Assert.IsFalse(queue.TryEnqueue(chunk));
        Assert.AreEqual(0, pool.ReturnCount);
    }

    private static PooledAudioChunk CreateChunk(CountingBufferPool pool, int length)
    {
        return new PooledAudioChunk(pool, pool.Rent(length), length);
    }

    private sealed class CountingBufferPool : IAudioBufferPool
    {
        public int RentCount { get; private set; }

        public int ReturnCount { get; private set; }

        public byte[] Rent(int minimumLength)
        {
            RentCount++;
            return new byte[minimumLength];
        }

        public void Return(byte[] buffer)
        {
            ReturnCount++;
        }
    }
}
