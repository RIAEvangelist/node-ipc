using System.Buffers;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;

namespace NodeIpc;

/// <summary>A reconnecting local, TCP, or TLS node-ipc client.</summary>
public sealed class Client : EventEndpoint, IAsyncDisposable
{
    private readonly object _stateGate = new();
    private readonly Action<object?[]> _log;
    private readonly TlsOptions? _tls;
    private readonly int _handshakeTimeout;
    private readonly bool _logPayloads;
    private readonly bool _synchronous;
    private CancellationTokenSource? _lifetime;
    private Task? _runTask;
    private TaskCompletionSource<IpcPeer> _firstConnection = NewConnectionSource();
    private readonly Queue<PendingClientWrite> _pendingBeforeConnect = new();
    private long _pendingBeforeConnectBytes;

    internal Client(Defaults config, Action<object?[]> log)
    {
        this.config = config;
        _log = log;
        _tls = config.tls?.Snapshot();
        _handshakeTimeout = config.messageTimeout > 0 ? config.messageTimeout : 30_000;
        _logPayloads = config.logPayloads;
        _synchronous = config.sync;
        parser = ParserFactory.create(config);
        raw = parser.raw;
        encoding = parser.wireEncoding;
        retriesRemaining = config.maxRetries;
    }

    public Defaults config { get; }
    public IParser parser { get; }
    public bool raw { get; }
    public System.Text.Encoding encoding { get; }
    public string? id { get; set; }
    public string? path { get; set; }
    public int? port { get; set; }
    public IpcPeer? socket { get; private set; }
    public long retriesRemaining { get; private set; }
    public bool retryTimer { get; private set; }
    public bool explicitlyDisconnected { get; private set; }
    public bool protocolViolation { get; private set; }
    public bool active
    {
        get
        {
            lock (_stateGate)
            {
                return _runTask is { IsCompleted: false };
            }
        }
    }

    public byte[] encode(string type) => parser.encode(type);
    public byte[] encode(string type, object? data) => parser.encode(type, data);

    public Client connect()
    {
        ValidateConnectionConfiguration();
        lock (_stateGate)
        {
            if (_runTask is { IsCompleted: false })
            {
                return this;
            }

            explicitlyDisconnected = false;
            protocolViolation = false;
            retriesRemaining = config.maxRetries;
            retryTimer = false;
            _lifetime?.Dispose();
            _lifetime = new CancellationTokenSource();
            _firstConnection = NewConnectionSource();
            _runTask = RunAsync(_lifetime.Token);
        }

        return this;
    }

    public Task<IpcPeer> waitForConnectAsync(CancellationToken cancellationToken = default) =>
        _firstConnection.Task.WaitAsync(cancellationToken);

    public bool emit(string type)
    {
        LogOutbound(type, null);
        return Queue(parser.encode(type), out _);
    }

    public bool emit(string type, object? data)
    {
        LogOutbound(type, data);
        return Queue(parser.encode(type, data), out _);
    }

    public bool emit(ReadOnlyMemory<byte> data)
    {
        if (!raw)
        {
            throw new InvalidOperationException("The byte-oriented emit overload requires the raw parser.");
        }

        LogOutbound("<raw-buffer>", data.Length);
        return Queue(data, out _);
    }

    public Task emitAsync(string type, CancellationToken cancellationToken = default)
    {
        LogOutbound(type, null);
        return QueueAsync(parser.encode(type), cancellationToken);
    }

    public Task emitAsync(string type, object? data, CancellationToken cancellationToken = default)
    {
        LogOutbound(type, data);
        return QueueAsync(parser.encode(type, data), cancellationToken);
    }

    public Task emitAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default)
    {
        if (!raw)
        {
            throw new InvalidOperationException("The byte-oriented emit overload requires the raw parser.");
        }

        LogOutbound("<raw-buffer>", data.Length);
        return QueueAsync(data, cancellationToken);
    }

    public async Task disconnectAsync(bool resetEvents = false)
    {
        var running = disconnect(resetEvents);

        if (running is not null && running.Id != Task.CurrentId)
        {
            try
            {
                await running.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Explicit disconnect owns this cancellation.
            }
        }
    }

    public Task? disconnect(bool resetEvents = false)
    {
        lock (_stateGate)
        {
            explicitlyDisconnected = true;
            retryTimer = false;
            if (resetEvents)
            {
                reset();
            }

            _lifetime?.Cancel();
            socket?.Abort();
            return _runTask;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await disconnectAsync(resetEvents: true).ConfigureAwait(false);
        _lifetime?.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        await Task.Yield();
        while (true)
        {
            IpcPeer? peer = null;
            var connected = false;
            var attempted = false;
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                attempted = true;
                peer = await OpenPeerAsync(cancellationToken).ConfigureAwait(false);
                socket = peer;
                connected = true;
                retriesRemaining = config.maxRetries;
                DrainPendingWrites(peer);
                _firstConnection.TrySetResult(peer);
                Publish("connect");
                using var registration = cancellationToken.Register(peer.Abort);
                await ReadLoopAsync(peer, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Lifecycle handling below keeps explicit disconnect deterministic.
            }
            catch (Exception error) when (error is not StackOverflowException and not OutOfMemoryException)
            {
                if (peer is null || Interlocked.Exchange(ref peer.FailureSignaled, 1) == 0)
                {
                    if (error is IPCProtocolException)
                    {
                        protocolViolation = true;
                    }
                    Publish("error", error);
                }
            }
            finally
            {
                if (peer is not null)
                {
                    await peer.DisposeAsync().ConfigureAwait(false);
                }
            }

            if (attempted || connected || explicitlyDisconnected || cancellationToken.IsCancellationRequested)
            {
                Publish("disconnect");
            }

            if (explicitlyDisconnected ||
                cancellationToken.IsCancellationRequested ||
                config.stopRetrying ||
                protocolViolation ||
                retriesRemaining < 1)
            {
                Publish("destroy");
                if (!_firstConnection.Task.IsCompleted)
                {
                    _firstConnection.TrySetException(new IOException("The IPC client stopped before connecting."));
                }
                FailPendingWrites(new IOException("The IPC client stopped before writing queued messages."));
                return;
            }

            retryTimer = true;
            try
            {
                await Task.Delay(config.retry, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                retryTimer = false;
                if (!_firstConnection.Task.IsCompleted)
                {
                    _firstConnection.TrySetException(new IOException("The IPC client stopped before connecting."));
                }
                FailPendingWrites(new IOException("The IPC client disconnected before writing queued messages."));
                Publish("destroy");
                return;
            }
            retryTimer = false;
            retriesRemaining--;
        }
    }

    private async Task<IpcPeer> OpenPeerAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("client has no socket path");
        }

        if (port is null)
        {
            return OperatingSystem.IsWindows()
                ? await OpenNamedPipeAsync(cancellationToken).ConfigureAwait(false)
                : await OpenUnixSocketAsync(cancellationToken).ConfigureAwait(false);
        }

        return await OpenTcpAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<IpcPeer> OpenNamedPipeAsync(CancellationToken cancellationToken)
    {
        _log(["connecting client on local socket", LocalTransport.PipePath(path!)]);
        var pipe = new NamedPipeClientStream(
            ".",
            LocalTransport.PipeName(path!),
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough);
        try
        {
            await pipe.ConnectAsync(cancellationToken).ConfigureAwait(false);
            var peer = new IpcPeer(pipe)
            {
                address = LocalTransport.PipePath(path!)
            };
            peer.SetStream(pipe);
            ConfigureWrites(peer);
            return peer;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<IpcPeer> OpenUnixSocketAsync(CancellationToken cancellationToken)
    {
        _log(["connecting client on local socket", path]);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(path!), cancellationToken).ConfigureAwait(false);
            var stream = new NetworkStream(socket, ownsSocket: true);
            var peer = new IpcPeer(socket)
            {
                address = path
            };
            peer.SetStream(stream);
            ConfigureWrites(peer);
            return peer;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private async Task<IpcPeer> OpenTcpAsync(CancellationToken cancellationToken)
    {
        var requestedFamily = config.@interface.family ??
            config.@interface.localAddress?.AddressFamily ??
            AddressFamily.Unspecified;
        var requiresExplicitSocket = requestedFamily != AddressFamily.Unspecified ||
            config.@interface.localAddress is not null ||
            config.@interface.localPort is not null;
        IPAddress? remoteAddress = null;
        if (requiresExplicitSocket)
        {
            var addresses = IPAddress.TryParse(path, out var literal)
                ? [literal]
                : await Dns.GetHostAddressesAsync(path!, cancellationToken).ConfigureAwait(false);
            remoteAddress = requestedFamily == AddressFamily.Unspecified
                ? addresses.FirstOrDefault()
                : addresses.FirstOrDefault(address => address.AddressFamily == requestedFamily);
            if (remoteAddress is null)
            {
                throw new SocketException((int)SocketError.AddressFamilyNotSupported);
            }
            requestedFamily = remoteAddress.AddressFamily;
        }

        var client = requiresExplicitSocket ? new TcpClient(requestedFamily) : new TcpClient();
        try
        {
            if (config.@interface.localAddress is not null || config.@interface.localPort is not null)
            {
                var localAddress = config.@interface.localAddress ??
                    (requestedFamily == AddressFamily.InterNetworkV6 ? IPAddress.IPv6Any : IPAddress.Any);
                if (localAddress.AddressFamily != requestedFamily)
                {
                    throw new SocketException((int)SocketError.AddressFamilyNotSupported);
                }
                client.Client.Bind(new IPEndPoint(localAddress, config.@interface.localPort ?? 0));
            }

            client.NoDelay = true;
            if (remoteAddress is null)
            {
                await client.ConnectAsync(path!, port!.Value, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await client.ConnectAsync(remoteAddress, port!.Value, cancellationToken).ConfigureAwait(false);
            }
            Stream stream = client.GetStream();
            if (_tls is not null)
            {
                _log(["connecting client via TLS", path, port]);
                using var handshake = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                handshake.CancelAfter(_handshakeTimeout);
                stream = await TransportSecurity.AuthenticateClientAsync(
                    stream,
                    path!,
                    _tls,
                    handshake.Token).ConfigureAwait(false);
            }
            else
            {
                _log(["connecting client via TCP", path, port]);
            }

            var remote = client.Client.RemoteEndPoint as IPEndPoint;
            var peer = new IpcPeer(client)
            {
                address = remote?.Address.ToString() ?? path,
                port = remote?.Port ?? port
            };
            peer.SetStream(stream);
            ConfigureWrites(peer);
            return peer;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    private void ConfigureWrites(IpcPeer peer)
    {
        peer.Writes = new WriteQueue(
            async (data, cancellationToken) =>
            {
                await peer.Stream.WriteAsync(data, cancellationToken).ConfigureAwait(false);
                await peer.Stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            },
            error => SignalFailure(peer, error),
            peer.Lifetime.Token,
            parser.maxPendingBytes,
            _synchronous);
    }

    private async Task ReadLoopAsync(IpcPeer peer, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            peer.Lifetime.Token);
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            while (!linked.IsCancellationRequested)
            {
                var count = await peer.Stream.ReadAsync(buffer, linked.Token).ConfigureAwait(false);
                if (count == 0)
                {
                    if (!raw)
                    {
                        lock (peer.ProtocolGate)
                        {
                            peer.incompleteFrameBytes = peer.Buffer.length;
                        }
                    }
                    return;
                }

                if (raw)
                {
                    var data = buffer.AsSpan(0, count).ToArray();
                    Publish("data", data);
                    peer.Acknowledge();
                    continue;
                }

                lock (peer.ProtocolGate)
                {
                    parser.read(peer.Buffer, buffer.AsSpan(0, count), message =>
                    {
                        if (_logPayloads)
                        {
                            _log(["received event", message.type, message.DispatchData]);
                        }
                        Publish(message.type, message.DispatchData);
                        peer.Acknowledge();
                    });
                    UpdateMessageTimer(peer);
                }
            }
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested)
        {
            // Closing a stream is the normal loop exit path.
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            peer.ClearMessageTimer();
        }
    }

    private void UpdateMessageTimer(IpcPeer peer)
    {
        if (parser.messageTimeout == 0 || peer.Buffer.length == 0)
        {
            if (peer.Buffer.length == 0)
            {
                peer.ClearMessageTimer();
            }
            return;
        }

        peer.StartMessageTimer(parser.messageTimeout, () =>
        {
            lock (peer.ProtocolGate)
            {
                if (peer.destroyed || peer.Buffer.length == 0)
                {
                    return;
                }
                SignalFailure(
                    peer,
                    new IPCProtocolException(
                        IPCProtocolCodes.MessageTimeout,
                        "incomplete message exceeded messageTimeout"));
            }
        });
    }

    private bool Queue(ReadOnlyMemory<byte> data, out Task completion)
    {
        IpcPeer? peer;
        lock (_stateGate)
        {
            peer = socket;
            if (peer?.Writes is null || peer.destroyed)
            {
                if (_runTask is not { IsCompleted: false } || explicitlyDisconnected || protocolViolation)
                {
                    completion = Task.FromException(new IOException("The IPC client is not connected."));
                    return false;
                }

                if (parser.maxPendingBytes is long maximum &&
                    _pendingBeforeConnectBytes + data.Length > maximum)
                {
                    var error = new IPCProtocolException(
                        IPCProtocolCodes.Backpressure,
                        "pending socket writes exceed maxPendingBytes");
                    completion = Task.FromException(error);
                    protocolViolation = true;
                    _lifetime?.Cancel();
                    Publish("error", error);
                    return false;
                }

                var pending = new PendingClientWrite(data.ToArray());
                _pendingBeforeConnect.Enqueue(pending);
                _pendingBeforeConnectBytes += pending.Data.Length;
                completion = pending.Completion.Task;
                return _synchronous || _pendingBeforeConnectBytes < WriteQueue.DefaultHighWaterMark;
            }
        }

        if (peer.Writes.TryEnqueue(data, out completion, out var writable))
        {
            return _synchronous || writable;
        }

        try
        {
            completion.GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            SignalFailure(peer, error);
        }
        return false;
    }

    private void DrainPendingWrites(IpcPeer peer)
    {
        PendingClientWrite[] pending;
        lock (_stateGate)
        {
            pending = [.. _pendingBeforeConnect];
            _pendingBeforeConnect.Clear();
            _pendingBeforeConnectBytes = 0;
        }

        foreach (var write in pending)
        {
            if (peer.Writes!.TryEnqueue(write.Data, out var completion))
            {
                _ = BridgeCompletionAsync(completion, write.Completion);
                continue;
            }

            _ = BridgeCompletionAsync(completion, write.Completion);
            try
            {
                completion.GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                SignalFailure(peer, error);
            }
        }
    }

    private void FailPendingWrites(Exception error)
    {
        PendingClientWrite[] pending;
        lock (_stateGate)
        {
            pending = [.. _pendingBeforeConnect];
            _pendingBeforeConnect.Clear();
            _pendingBeforeConnectBytes = 0;
        }

        foreach (var write in pending)
        {
            write.Completion.TrySetException(error);
        }
    }

    private static async Task BridgeCompletionAsync(Task source, TaskCompletionSource destination)
    {
        try
        {
            await source.ConfigureAwait(false);
            destination.TrySetResult();
        }
        catch (Exception error)
        {
            destination.TrySetException(error);
        }
    }

    private async Task QueueAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        if (!Queue(data, out var completion))
        {
            await completion.ConfigureAwait(false);
            return;
        }

        await completion.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private void SignalFailure(IpcPeer peer, Exception error)
    {
        if (error is IPCProtocolException)
        {
            protocolViolation = true;
            lock (peer.ProtocolGate)
            {
                peer.Buffer.clear();
            }
        }
        var publish = Interlocked.Exchange(ref peer.FailureSignaled, 1) == 0;
        peer.Abort();
        if (publish)
        {
            Publish("error", error);
        }
    }

    private void ValidateConnectionConfiguration()
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        if (port is not null && parser.profile == "assured" && _tls is null)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.AssuredTransport,
                "The assured parser requires TLS for network connections.");
        }

        if (port is not null && _tls is not null)
        {
            TransportSecurity.ValidateClientConfiguration(_tls, parser.profile == "assured");
        }
    }

    private void LogOutbound(string type, object? data)
    {
        if (_logPayloads)
        {
            _log(["dispatching event to", id, path, ":", type, data]);
        }
    }

    private static TaskCompletionSource<IpcPeer> NewConnectionSource() => new(
        TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class PendingClientWrite
    {
        public PendingClientWrite(byte[] data)
        {
            Data = data;
            Completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public byte[] Data { get; }
        public TaskCompletionSource Completion { get; }
    }
}
