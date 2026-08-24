using System.Net;
using System.Net.Sockets;

namespace NodeIpc;

/// <summary>A connected stream client or a learned UDP endpoint.</summary>
public sealed class IpcPeer : IAsyncDisposable
{
    private readonly object _gate = new();
    private Stream? _stream;
    private int _disposed;
    private int _lifetimeDisposed;

    internal IpcPeer(object? native = null)
    {
        this.native = native;
    }

    public IpcPeer(string address, int port)
        : this(address, port, null)
    {
    }

    internal IpcPeer(string address, int port, AddressFamily? addressFamily)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(address);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(port);
        if (port > 65_535)
        {
            throw new ArgumentOutOfRangeException(nameof(port));
        }
        var resolved = ResolveAddress(address, addressFamily);
        this.address = address;
        this.port = port;
        RemoteEndPoint = new IPEndPoint(resolved, port);
    }

    public string? id { get; set; }
    public string? address { get; internal set; }
    public int? port { get; internal set; }
    public object? native { get; }
    public bool destroyed => Volatile.Read(ref _disposed) != 0;
    public bool readable => !destroyed && _stream?.CanRead == true;
    public long writableLength => Writes?.PendingBytes ?? 0;
    /// <summary>Bytes left in an incomplete framed message when the remote stream ended.</summary>
    public int incompleteFrameBytes { get; internal set; }

    private static IPAddress ResolveAddress(string address, AddressFamily? addressFamily)
    {
        if (IPAddress.TryParse(address, out var literal))
        {
            if (addressFamily is not null && literal.AddressFamily != addressFamily)
            {
                throw new ArgumentException(
                    $"Peer address '{address}' is not compatible with {addressFamily}.",
                    nameof(address));
            }
            return literal;
        }

        return Dns.GetHostAddresses(address)
            .FirstOrDefault(candidate => addressFamily is null || candidate.AddressFamily == addressFamily)
            ?? throw new ArgumentException(
                addressFamily is null
                    ? $"Unable to resolve peer address '{address}'."
                    : $"Unable to resolve peer address '{address}' for {addressFamily}.",
                nameof(address));
    }

    internal FrameBuffer Buffer { get; } = new();
    internal object ProtocolGate { get; } = new();
    internal CancellationTokenSource Lifetime { get; } = new();
    internal WriteQueue? Writes { get; set; }
    internal Timer? MessageTimer { get; set; }
    internal EndPoint? RemoteEndPoint { get; set; }
    internal int FailureSignaled;
    internal long LastActivityTicks { get; set; } = DateTime.UtcNow.Ticks;

    internal Stream Stream
    {
        get
        {
            lock (_gate)
            {
                return _stream ?? throw new InvalidOperationException("The peer stream is not connected.");
            }
        }
    }

    internal void SetStream(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        lock (_gate)
        {
            if (_stream is not null)
            {
                throw new InvalidOperationException("The peer already owns a stream.");
            }

            _stream = stream;
        }
    }

    internal void Acknowledge() => Writes?.Acknowledge();

    internal void ClearMessageTimer()
    {
        Timer? timer;
        lock (_gate)
        {
            timer = MessageTimer;
            MessageTimer = null;
        }
        timer?.Dispose();
    }

    internal void StartMessageTimer(int timeoutMilliseconds, Action expired)
    {
        lock (_gate)
        {
            if (MessageTimer is not null || destroyed)
            {
                return;
            }

            MessageTimer = new Timer(_ => expired(), null, timeoutMilliseconds, Timeout.Infinite);
        }
    }

    internal void Abort()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        ClearMessageTimer();
        lock (ProtocolGate)
        {
            Buffer.release();
        }
        Lifetime.Cancel();
        Writes?.Stop(new OperationCanceledException("The IPC peer was closed."));
        lock (_gate)
        {
            try
            {
                _stream?.Dispose();
            }
            catch (IOException)
            {
                // Closing a failed transport is best effort.
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        Abort();
        if (Interlocked.Exchange(ref _lifetimeDisposed, 1) == 0)
        {
            Lifetime.Dispose();
        }
        return ValueTask.CompletedTask;
    }
}

internal sealed class WriteQueue
{
    internal const long DefaultHighWaterMark = 16 * 1024;
    private readonly object _gate = new();
    private readonly Queue<PendingWrite> _queue = new();
    private readonly Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> _writer;
    private readonly Action<Exception> _failure;
    private readonly CancellationToken _cancellationToken;
    private readonly long? _maximumPendingBytes;
    private readonly bool _synchronous;
    private TaskCompletionSource? _acknowledgement;
    private int _acknowledgementCredits;
    private bool _pumping;
    private bool _stopped;
    private long _pendingBytes;

    public WriteQueue(
        Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> writer,
        Action<Exception> failure,
        CancellationToken cancellationToken,
        long? maximumPendingBytes,
        bool synchronous = false)
    {
        _writer = writer;
        _failure = failure;
        _cancellationToken = cancellationToken;
        _maximumPendingBytes = maximumPendingBytes;
        _synchronous = synchronous;
    }

    public long PendingBytes => Interlocked.Read(ref _pendingBytes);

    public bool TryEnqueue(ReadOnlyMemory<byte> data, out Task completion) =>
        TryEnqueue(data, out completion, out _);

    public bool TryEnqueue(ReadOnlyMemory<byte> data, out Task completion, out bool writable)
    {
        var pending = new PendingWrite(data.ToArray());
        lock (_gate)
        {
            if (_stopped)
            {
                pending.Completion.TrySetException(new IOException("The IPC write queue is closed."));
                completion = pending.Completion.Task;
                writable = false;
                return false;
            }

            if (_maximumPendingBytes is long maximum &&
                _pendingBytes + pending.Data.Length > maximum)
            {
                var error = new IPCProtocolException(
                    IPCProtocolCodes.Backpressure,
                    "pending socket writes exceed maxPendingBytes");
                pending.Completion.TrySetException(error);
                completion = pending.Completion.Task;
                writable = false;
                return false;
            }

            _pendingBytes += pending.Data.Length;
            writable = _pendingBytes < DefaultHighWaterMark;
            _queue.Enqueue(pending);
            completion = pending.Completion.Task;
            if (_pumping)
            {
                return true;
            }

            _pumping = true;
            _ = PumpAsync();
            return true;
        }
    }

    public void Acknowledge()
    {
        TaskCompletionSource? acknowledgement;
        lock (_gate)
        {
            if (!_synchronous)
            {
                return;
            }
            acknowledgement = _acknowledgement;
            if (acknowledgement is null || acknowledgement.Task.IsCompleted)
            {
                if (_pumping && _queue.Count > _acknowledgementCredits)
                {
                    _acknowledgementCredits++;
                }
                return;
            }
        }
        acknowledgement?.TrySetResult();
    }

    public void Stop(Exception error)
    {
        List<PendingWrite> pending;
        TaskCompletionSource? acknowledgement;
        lock (_gate)
        {
            if (_stopped)
            {
                return;
            }

            _stopped = true;
            pending = [.. _queue];
            _queue.Clear();
            foreach (var write in pending)
            {
                _pendingBytes -= write.Data.Length;
            }
            acknowledgement = _acknowledgement;
            _acknowledgement = null;
            _acknowledgementCredits = 0;
        }

        foreach (var write in pending)
        {
            write.Completion.TrySetException(error);
        }
        acknowledgement?.TrySetException(error);
    }

    private async Task PumpAsync()
    {
        while (true)
        {
            PendingWrite pending;
            lock (_gate)
            {
                if (_stopped || _queue.Count == 0)
                {
                    _pumping = false;
                    return;
                }

                pending = _queue.Dequeue();
            }

            try
            {
                Task? acknowledgement = null;
                if (_synchronous)
                {
                    lock (_gate)
                    {
                        if (_acknowledgementCredits > 0)
                        {
                            _acknowledgementCredits--;
                            _acknowledgement = null;
                        }
                        else
                        {
                            _acknowledgement = new TaskCompletionSource(
                                TaskCreationOptions.RunContinuationsAsynchronously);
                            acknowledgement = _acknowledgement.Task;
                        }
                    }
                }
                await _writer(pending.Data, _cancellationToken).ConfigureAwait(false);
                pending.Completion.TrySetResult();
                if (acknowledgement is not null)
                {
                    await acknowledgement.WaitAsync(_cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception error) when (error is not StackOverflowException and not OutOfMemoryException)
            {
                pending.Completion.TrySetException(error);
                Stop(error);
                if (!_cancellationToken.IsCancellationRequested)
                {
                    _failure(error);
                }
                return;
            }
            finally
            {
                if (_synchronous)
                {
                    lock (_gate)
                    {
                        _acknowledgement = null;
                    }
                }
                Interlocked.Add(ref _pendingBytes, -pending.Data.Length);
            }
        }
    }

    private sealed class PendingWrite
    {
        public PendingWrite(byte[] data)
        {
            Data = data;
            Completion = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public byte[] Data { get; }
        public TaskCompletionSource Completion { get; }
    }
}
