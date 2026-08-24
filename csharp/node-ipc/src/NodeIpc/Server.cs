using System.Buffers;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;

namespace NodeIpc;

/// <summary>A local, TCP, TLS, UDP4, or UDP6 node-ipc server.</summary>
public sealed class Server : EventEndpoint, IAsyncDisposable
{
    private readonly object _stateGate = new();
    private readonly Action<object?[]> _log;
    private readonly TlsOptions? _tls;
    private readonly bool _readableAll;
    private readonly bool _writableAll;
    private readonly int _handshakeTimeout;
    private readonly bool _identifyPeer;
    private readonly bool _logPayloads;
    private readonly Dictionary<string, IpcPeer> _udpPeers = new(StringComparer.Ordinal);
    private readonly HashSet<Task> _backgroundTasks = [];
    private CancellationTokenSource? _lifetime;
    private TcpListener? _tcpListener;
    private Socket? _unixListener;
    private UdpClient? _udp;
    private Task? _acceptTask;
    private Task? _stopTask;
    private bool _started;
    private bool _ownsUnixEndpoint;
    private UnixFileStatus? _unixEndpointIdentity;
    private bool _udp4;
    private bool _udp6;
    private int _pendingConnections;

    internal Server(string socketPath, Defaults config, Action<object?[]> log, int? port = null)
    {
        this.config = config;
        path = socketPath;
        this.port = port;
        _log = log;
        _tls = config.tls?.Snapshot();
        _readableAll = config.readableAll;
        _writableAll = config.writableAll;
        _handshakeTimeout = config.messageTimeout > 0 ? config.messageTimeout : 30_000;
        _identifyPeer = config.identifyPeer;
        _logPayloads = config.logPayloads;
        parser = ParserFactory.create(config);
        raw = parser.raw;
        encoding = parser.wireEncoding;
    }

    public Defaults config { get; }
    public string path { get; set; }
    public int? port { get; set; }
    public IParser parser { get; }
    public bool raw { get; }
    public System.Text.Encoding encoding { get; }
    public object? server { get; private set; }
    public List<IpcPeer> sockets { get; } = [];
    public IpcPeer? lastPeer { get; private set; }

    public bool udp4
    {
        get => _udp4;
        set
        {
            EnsureNotStarted();
            _udp4 = value;
            if (value)
            {
                _udp6 = false;
            }
        }
    }

    public bool udp6
    {
        get => _udp6;
        set
        {
            EnsureNotStarted();
            _udp6 = value;
            if (value)
            {
                _udp4 = false;
            }
        }
    }

    public byte[] encode(string type) => parser.encode(type);
    public byte[] encode(string type, object? data) => parser.encode(type, data);

    public IpcPeer peer(string address, int port) => new(
        address,
        port,
        udp4 ? AddressFamily.InterNetwork : udp6 ? AddressFamily.InterNetworkV6 : null);

    public Server on<T>(string type, Action<T, IpcPeer> handler)
    {
        base.on<T, IpcPeer>(type, handler);
        return this;
    }

    public Server once<T>(string type, Action<T, IpcPeer> handler)
    {
        base.once<T, IpcPeer>(type, handler);
        return this;
    }

    public Server start()
    {
        var publishDatagramConnect = false;
        lock (_stateGate)
        {
            if (_started)
            {
                return this;
            }
            if (_stopTask is { IsCompleted: false })
            {
                throw new InvalidOperationException("The IPC server is still stopping.");
            }
            _stopTask = null;

            ValidateStart();
            _lifetime = new CancellationTokenSource();
            try
            {
                if (udp4 || udp6)
                {
                    StartDatagram(_lifetime.Token);
                    publishDatagramConnect = true;
                }
                else if (port is not null)
                {
                    StartTcp(_lifetime.Token);
                }
                else if (OperatingSystem.IsWindows())
                {
                    StartNamedPipe(_lifetime.Token);
                }
                else
                {
                    StartUnixSocket(_lifetime.Token);
                }

                _started = true;
            }
            catch
            {
                _lifetime.Cancel();
                _tcpListener?.Stop();
                _unixListener?.Dispose();
                _udp?.Dispose();
                if (_ownsUnixEndpoint && _unixEndpointIdentity is { } identity)
                {
                    LocalTransport.RemoveOwnedSocket(path, identity);
                }
                _ownsUnixEndpoint = false;
                _unixEndpointIdentity = null;
                _lifetime.Dispose();
                _lifetime = null;
                _tcpListener = null;
                _unixListener = null;
                _udp = null;
                _acceptTask = null;
                server = null;
                throw;
            }
        }

        if (publishDatagramConnect)
        {
            Publish("connect", server);
        }
        Publish("start", server);
        return this;
    }

    public Task<Server> startAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(start());
    }

    public bool emit(IpcPeer? socket, string type)
    {
        LogOutbound(socket is null ? "broadcasting event" : "dispatching event to socket", type, null);
        var frame = parser.encode(type);
        return socket is null ? BroadcastFrame(frame, out _) : Queue(socket, frame, out _);
    }

    public bool emit(IpcPeer? socket, string type, object? data)
    {
        LogOutbound(socket is null ? "broadcasting event" : "dispatching event to socket", type, data);
        var frame = parser.encode(type, data);
        return socket is null ? BroadcastFrame(frame, out _) : Queue(socket, frame, out _);
    }

    public bool emit(IpcPeer? socket, ReadOnlyMemory<byte> data)
    {
        if (!raw)
        {
            throw new InvalidOperationException("The byte-oriented emit overload requires the raw parser.");
        }

        LogOutbound(socket is null ? "broadcasting event" : "dispatching event to socket", "<raw-buffer>", data.Length);
        return socket is null ? BroadcastFrame(data, out _) : Queue(socket, data, out _);
    }

    public bool broadcast(string type)
    {
        LogOutbound("broadcasting event", type, null);
        return BroadcastFrame(parser.encode(type), out _);
    }

    public bool broadcast(string type, object? data)
    {
        LogOutbound("broadcasting event", type, data);
        return BroadcastFrame(parser.encode(type, data), out _);
    }

    public bool broadcast(ReadOnlyMemory<byte> data)
    {
        if (!raw)
        {
            throw new InvalidOperationException("The byte-oriented broadcast overload requires the raw parser.");
        }

        LogOutbound("broadcasting event", "<raw-buffer>", data.Length);
        return BroadcastFrame(data, out _);
    }

    public Task emitAsync(
        IpcPeer? socket,
        string type,
        CancellationToken cancellationToken = default)
    {
        LogOutbound(socket is null ? "broadcasting event" : "dispatching event to socket", type, null);
        return SendFrameAsync(socket, parser.encode(type), cancellationToken);
    }

    public Task emitAsync(
        IpcPeer? socket,
        string type,
        object? data,
        CancellationToken cancellationToken = default)
    {
        LogOutbound(socket is null ? "broadcasting event" : "dispatching event to socket", type, data);
        return SendFrameAsync(socket, parser.encode(type, data), cancellationToken);
    }

    public Task broadcastAsync(string type, CancellationToken cancellationToken = default)
    {
        LogOutbound("broadcasting event", type, null);
        return SendFrameAsync(null, parser.encode(type), cancellationToken);
    }

    public Task broadcastAsync(
        string type,
        object? data,
        CancellationToken cancellationToken = default)
    {
        LogOutbound("broadcasting event", type, data);
        return SendFrameAsync(null, parser.encode(type, data), cancellationToken);
    }

    public void stop()
    {
        _ = EnsureStopTask();
    }

    public Task stopAsync() => EnsureStopTask();

    public void serverError(Exception error)
    {
        _log(["server error", error]);
        Publish("error", error);
    }

    public async ValueTask DisposeAsync() => await stopAsync().ConfigureAwait(false);

    private void ValidateStart()
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("socket server path not specified");
        }

        if (parser.profile == "assured")
        {
            if (udp4 || udp6 || (port is not null && _tls is null))
            {
                throw new IPCProtocolException(
                    IPCProtocolCodes.AssuredTransport,
                    "The assured parser requires TLS for network servers.");
            }

            if (port is null && OperatingSystem.IsWindows())
            {
                throw new IPCProtocolException(
                    IPCProtocolCodes.AssuredTransport,
                    "Assured local transport requires Unix socket ownership checks; use mutual TLS or an application-owned Windows ACL.");
            }

            if (port is null && !config.secureSocketRoot)
            {
                throw new IPCProtocolException(
                    IPCProtocolCodes.AssuredTransport,
                    "The assured parser requires secureSocketRoot for local sockets.");
            }

            if (port is null && !LocalTransport.EndpointDirectlyInsideRoot(path, config.socketRoot))
            {
                throw new IPCProtocolException(
                    IPCProtocolCodes.AssuredTransport,
                    "The assured parser requires a local endpoint directly inside socketRoot.");
            }
        }

        if (port is null && OperatingSystem.IsWindows() && (_readableAll || _writableAll))
        {
            throw new PlatformNotSupportedException(
                "readableAll and writableAll require an explicit Windows pipe ACL, which the dependency-free transport does not guess.");
        }

        if (port is not null && _tls is not null)
        {
            TransportSecurity.ValidateServerConfiguration(_tls, parser.profile == "assured");
        }
    }

    private void StartTcp(CancellationToken cancellationToken)
    {
        var address = ResolveBindAddress(path, udp6 ? AddressFamily.InterNetworkV6 : null);
        _tcpListener = new TcpListener(address, port!.Value);
        _tcpListener.Start(config.maxConnections);
        server = _tcpListener;
        _acceptTask = AcceptTcpLoopAsync(_tcpListener, cancellationToken);
    }

    private void StartNamedPipe(CancellationToken cancellationToken)
    {
        path = LocalTransport.PipePath(path);
        server = this;
        _acceptTask = AcceptNamedPipeLoopAsync(cancellationToken);
    }

    private void StartUnixSocket(CancellationToken cancellationToken)
    {
        LocalTransport.PrepareSocketRoot(path, config);
        if (config.unlink)
        {
            LocalTransport.RemoveStaleSocket(path);
        }

        _unixListener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        _unixListener.Bind(new UnixDomainSocketEndPoint(path));
        _ownsUnixEndpoint = true;
        _unixEndpointIdentity = UnixFileSystem.Stat(path);
        var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if (_readableAll)
        {
            mode |= UnixFileMode.GroupRead | UnixFileMode.OtherRead;
        }
        if (_writableAll)
        {
            mode |= UnixFileMode.GroupWrite | UnixFileMode.OtherWrite;
        }
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, mode);
        }
        _unixListener.Listen(config.maxConnections);
        server = _unixListener;
        _acceptTask = AcceptUnixLoopAsync(_unixListener, cancellationToken);
    }

    private void StartDatagram(CancellationToken cancellationToken)
    {
        if (port is null)
        {
            throw new InvalidOperationException("UDP servers require a port.");
        }

        var family = udp4 ? AddressFamily.InterNetwork : AddressFamily.InterNetworkV6;
        var address = ResolveBindAddress(path, family);
        _udp = new UdpClient(family);
        _udp.Client.Bind(new IPEndPoint(address, port.Value));
        server = _udp;
        _acceptTask = ReceiveDatagramsAsync(_udp, cancellationToken);
    }

    private async Task AcceptTcpLoopAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                serverError(error);
                continue;
            }

            if (SocketCount() + Volatile.Read(ref _pendingConnections) >= config.maxConnections)
            {
                client.Dispose();
                continue;
            }

            client.NoDelay = true;
            Interlocked.Increment(ref _pendingConnections);
            TrackBackgroundTask(AddTcpClientAsync(client, cancellationToken));
        }
    }

    private async Task AddTcpClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        try
        {
            Stream stream = client.GetStream();
            if (_tls is not null)
            {
                using var handshake = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                handshake.CancelAfter(_handshakeTimeout);
                stream = await TransportSecurity.AuthenticateServerAsync(
                    stream,
                    _tls,
                    handshake.Token).ConfigureAwait(false);
            }

            var remote = client.Client.RemoteEndPoint as IPEndPoint;
            var peer = new IpcPeer(client)
            {
                address = remote?.Address.ToString(),
                port = remote?.Port,
                RemoteEndPoint = remote
            };
            peer.SetStream(stream);
            AddStreamPeer(peer, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            client.Dispose();
        }
        catch (Exception error)
        {
            client.Dispose();
            serverError(error);
        }
        finally
        {
            Interlocked.Decrement(ref _pendingConnections);
        }
    }

    private async Task AcceptUnixLoopAsync(Socket listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            Socket accepted;
            try
            {
                accepted = await listener.AcceptAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                serverError(error);
                continue;
            }

            if (SocketCount() >= config.maxConnections)
            {
                accepted.Dispose();
                continue;
            }
            var peer = new IpcPeer(accepted)
            {
                address = path,
                RemoteEndPoint = accepted.RemoteEndPoint
            };
            peer.SetStream(new NetworkStream(accepted, ownsSocket: true));
            AddStreamPeer(peer, cancellationToken);
        }
    }

    private async Task AcceptNamedPipeLoopAsync(CancellationToken cancellationToken)
    {
        var pipeName = LocalTransport.PipeName(path);
        while (!cancellationToken.IsCancellationRequested)
        {
            if (SocketCount() >= config.maxConnections)
            {
                await Task.Delay(10, cancellationToken).ConfigureAwait(false);
                continue;
            }
            var options = PipeOptions.Asynchronous | PipeOptions.WriteThrough;
            options |= PipeOptions.CurrentUserOnly;
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    Math.Clamp(config.maxConnections, 1, 254),
                    PipeTransmissionMode.Byte,
                    options);
                await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                if (pipe is not null)
                {
                    await pipe.DisposeAsync().ConfigureAwait(false);
                }
                return;
            }
            catch (Exception error)
            {
                if (pipe is not null)
                {
                    await pipe.DisposeAsync().ConfigureAwait(false);
                }
                serverError(error);
                await Task.Delay(10, cancellationToken).ConfigureAwait(false);
                continue;
            }

            var peer = new IpcPeer(pipe)
            {
                address = path
            };
            peer.SetStream(pipe);
            AddStreamPeer(peer, cancellationToken);
        }
    }

    private void AddStreamPeer(IpcPeer peer, CancellationToken serverCancellation)
    {
        peer.Writes = new WriteQueue(
            async (data, cancellationToken) =>
            {
                await peer.Stream.WriteAsync(data, cancellationToken).ConfigureAwait(false);
                await peer.Stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            },
            error => SignalFailure(peer, error),
            peer.Lifetime.Token,
            parser.maxPendingBytes);
        var accepted = false;
        lock (_stateGate)
        {
            if (!serverCancellation.IsCancellationRequested)
            {
                sockets.Add(peer);
                accepted = true;
            }
        }
        if (!accepted)
        {
            _ = peer.DisposeAsync();
            return;
        }
        TrackBackgroundTask(HandleStreamPeerAsync(peer, serverCancellation));
    }

    private async Task HandleStreamPeerAsync(IpcPeer peer, CancellationToken serverCancellation)
    {
        await Task.Yield();
        try
        {
            if (serverCancellation.IsCancellationRequested || peer.destroyed)
            {
                return;
            }
            Publish("connect", peer);
            await ReadStreamPeerAsync(peer, serverCancellation).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (serverCancellation.IsCancellationRequested || peer.destroyed)
        {
            // Normal shutdown.
        }
        catch (Exception error) when (error is not StackOverflowException and not OutOfMemoryException)
        {
            SignalFailure(peer, error);
        }
        finally
        {
            RemoveSocket(peer, publishLifecycle: true);
        }
    }

    private async Task ReadStreamPeerAsync(IpcPeer peer, CancellationToken serverCancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            serverCancellation,
            peer.Lifetime.Token);
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            while (!linked.IsCancellationRequested)
            {
                var count = await peer.Stream.ReadAsync(buffer, linked.Token).ConfigureAwait(false);
                if (count == 0)
                {
                    lock (peer.ProtocolGate)
                    {
                        peer.incompleteFrameBytes = peer.Buffer.length;
                    }
                    return;
                }

                DispatchBytes(peer, buffer.AsSpan(0, count));
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            peer.ClearMessageTimer();
        }
    }

    private async Task ReceiveDatagramsAsync(UdpClient udp, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            UdpReceiveResult result;
            try
            {
                result = await udp.ReceiveAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                serverError(error);
                continue;
            }

            IpcPeer? peer = null;
            try
            {
                peer = GetDatagramPeer(result.RemoteEndPoint);
                DispatchBytes(peer, result.Buffer);
            }
            catch (Exception error) when (error is not StackOverflowException and not OutOfMemoryException)
            {
                if (peer is null)
                {
                    serverError(error);
                }
                else
                {
                    RemoveDatagramPeer(peer);
                    SignalFailure(peer, error, abort: false);
                }
            }
        }
    }

    private IpcPeer GetDatagramPeer(IPEndPoint endpoint)
    {
        var key = endpoint.ToString();
        IpcPeer? evicted = null;
        IpcPeer peer;
        lock (_stateGate)
        {
            if (_udpPeers.TryGetValue(key, out var existing))
            {
                existing.LastActivityTicks = DateTime.UtcNow.Ticks;
                lastPeer = existing;
                return existing;
            }

            if (sockets.Count >= config.maxConnections)
            {
                evicted = sockets
                    .Where(candidate => candidate.Buffer.length == 0)
                    .MinBy(candidate => candidate.LastActivityTicks);
                if (evicted is null)
                {
                    throw new IPCProtocolException(
                        IPCProtocolCodes.Backpressure,
                        "UDP peer count exceeds maxConnections while every retained peer has a partial frame");
                }

                sockets.Remove(evicted);
                if (evicted.RemoteEndPoint is IPEndPoint evictedEndpoint)
                {
                    _udpPeers.Remove(evictedEndpoint.ToString());
                }
            }

            peer = new IpcPeer(endpoint)
            {
                address = endpoint.Address.ToString(),
                port = endpoint.Port,
                RemoteEndPoint = endpoint,
                LastActivityTicks = DateTime.UtcNow.Ticks
            };
            ConfigureDatagramWrites(peer);
            _udpPeers[key] = peer;
            sockets.Add(peer);
            lastPeer = peer;
        }

        if (evicted is not null)
        {
            _ = evicted.DisposeAsync();
        }
        return peer;
    }

    private void DispatchBytes(IpcPeer peer, ReadOnlySpan<byte> data)
    {
        if (raw)
        {
            Publish("data", data.ToArray(), peer);
            return;
        }

        lock (peer.ProtocolGate)
        {
            parser.read(peer.Buffer, data, message =>
            {
                if (_identifyPeer && message.DispatchData is System.Text.Json.JsonElement element &&
                    element.ValueKind == System.Text.Json.JsonValueKind.Object &&
                    element.TryGetProperty("id", out var id) &&
                    id.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    peer.id = id.GetString();
                }
                if (_logPayloads)
                {
                    _log(["received event", message.type, message.DispatchData]);
                }
                Publish(message.type, message.DispatchData, peer);
            });
            peer.LastActivityTicks = DateTime.UtcNow.Ticks;
            if ((udp4 || udp6) && parser.maxPendingBytes is long maximumPending)
            {
                long retained;
                lock (_stateGate)
                {
                    retained = sockets.Sum(candidate => (long)candidate.Buffer.length);
                }
                if (retained > maximumPending)
                {
                    throw new IPCProtocolException(
                        IPCProtocolCodes.Backpressure,
                        "retained UDP fragments exceed maxPendingBytes");
                }
            }
            UpdateMessageTimer(peer);
            if ((udp4 || udp6) && peer.Buffer.length == 0)
            {
                peer.Buffer.release();
            }
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
                var error = new IPCProtocolException(
                    IPCProtocolCodes.MessageTimeout,
                    "incomplete message exceeded messageTimeout");
                if (udp4 || udp6)
                {
                    RemoveDatagramPeer(peer);
                    SignalFailure(peer, error, abort: false);
                }
                else
                {
                    SignalFailure(peer, error);
                }
            }
        });
    }

    private bool Queue(IpcPeer peer, ReadOnlyMemory<byte> data, out Task completion)
    {
        if ((udp4 || udp6) && peer.Writes is null && peer.RemoteEndPoint is not null)
        {
            ConfigureDatagramWrites(peer);
        }
        if (peer.destroyed || peer.Writes is null)
        {
            completion = Task.FromException(new IOException("The IPC peer is not writable."));
            return false;
        }

        if (peer.Writes.TryEnqueue(data, out completion, out var writable))
        {
            return writable;
        }

        try
        {
            completion.GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            if (udp4 || udp6)
            {
                RemoveDatagramPeer(peer);
                SignalFailure(peer, error, abort: false);
            }
            else
            {
                SignalFailure(peer, error);
            }
        }
        return false;
    }

    private void ConfigureDatagramWrites(IpcPeer peer)
    {
        peer.Writes = new WriteQueue(
            async (data, cancellationToken) =>
            {
                if (_udp is null || peer.RemoteEndPoint is null)
                {
                    throw new IOException("The UDP server is closed.");
                }
                await _udp.Client.SendToAsync(
                    data,
                    SocketFlags.None,
                    peer.RemoteEndPoint,
                    cancellationToken).ConfigureAwait(false);
            },
            error =>
            {
                RemoveDatagramPeer(peer);
                SignalFailure(peer, error, abort: false);
            },
            peer.Lifetime.Token,
            parser.maxPendingBytes);
    }

    private bool BroadcastFrame(ReadOnlyMemory<byte> data, out Task completion)
    {
        IpcPeer[] peers;
        lock (_stateGate)
        {
            peers = [.. sockets];
        }
        var completions = new List<Task>(peers.Length);
        var writable = true;
        foreach (var peer in peers)
        {
            if (!Queue(peer, data, out var queued))
            {
                writable = false;
            }
            completions.Add(queued);
        }
        completion = Task.WhenAll(completions);
        return writable;
    }

    private async Task SendFrameAsync(
        IpcPeer? peer,
        ReadOnlyMemory<byte> data,
        CancellationToken cancellationToken)
    {
        Task completion;
        var accepted = peer is null
            ? BroadcastFrame(data, out completion)
            : Queue(peer, data, out completion);
        if (!accepted)
        {
            await completion.ConfigureAwait(false);
            return;
        }
        await completion.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private void SignalFailure(IpcPeer peer, Exception error, bool abort = true)
    {
        if (error is IPCProtocolException)
        {
            lock (peer.ProtocolGate)
            {
                peer.Buffer.clear();
            }
        }
        var publish = Interlocked.Exchange(ref peer.FailureSignaled, 1) == 0;
        if (abort)
        {
            peer.Abort();
        }
        if (publish)
        {
            _log(["IPC protocol or transport error", error]);
            Publish("error", error);
        }
    }

    private void RemoveSocket(IpcPeer peer, bool publishLifecycle)
    {
        var removed = false;
        lock (_stateGate)
        {
            removed = sockets.Remove(peer);
            if (ReferenceEquals(lastPeer, peer))
            {
                lastPeer = null;
            }
            if (peer.RemoteEndPoint is IPEndPoint endpoint)
            {
                _udpPeers.Remove(endpoint.ToString());
            }
        }
        _ = peer.DisposeAsync();
        if (removed && publishLifecycle)
        {
            Publish("socket.disconnected", peer, peer.id);
            Publish("close", peer);
        }
    }

    private void RemoveDatagramPeer(IpcPeer peer)
    {
        lock (_stateGate)
        {
            sockets.Remove(peer);
            if (peer.RemoteEndPoint is IPEndPoint endpoint)
            {
                _udpPeers.Remove(endpoint.ToString());
            }
            if (ReferenceEquals(lastPeer, peer))
            {
                lastPeer = null;
            }
        }
        _ = peer.DisposeAsync();
    }

    private Task EnsureStopTask()
    {
        lock (_stateGate)
        {
            if (_stopTask is not null)
            {
                return _stopTask;
            }
            if (!_started && _lifetime is null)
            {
                return Task.CompletedTask;
            }

            _stopTask = StopCoreAsync();
            return _stopTask;
        }
    }

    private async Task StopCoreAsync()
    {
        Task? acceptTask;
        IpcPeer[] peers;
        lock (_stateGate)
        {
            if (!_started && _lifetime is null)
            {
                return;
            }
            _started = false;
            _lifetime?.Cancel();
            _tcpListener?.Stop();
            _unixListener?.Dispose();
            _udp?.Dispose();
            peers = [.. sockets];
            sockets.Clear();
            _udpPeers.Clear();
            lastPeer = null;
            acceptTask = _acceptTask;
        }

        foreach (var peer in peers)
        {
            _ = peer.DisposeAsync();
            if (!(udp4 || udp6))
            {
                Publish("close", peer);
            }
        }

        if (acceptTask is not null)
        {
            try
            {
                await acceptTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Server shutdown owns this cancellation.
            }
        }

        await DrainBackgroundTasksAsync().ConfigureAwait(false);

        if (_ownsUnixEndpoint && _unixEndpointIdentity is { } identity)
        {
            LocalTransport.RemoveOwnedSocket(path, identity);
            _ownsUnixEndpoint = false;
            _unixEndpointIdentity = null;
        }

        _lifetime?.Dispose();
        _lifetime = null;
        _tcpListener = null;
        _unixListener = null;
        _udp = null;
        _acceptTask = null;
        server = null;
    }

    private void TrackBackgroundTask(Task task)
    {
        lock (_stateGate)
        {
            _backgroundTasks.Add(task);
        }
        _ = task.ContinueWith(
            completed =>
            {
                lock (_stateGate)
                {
                    _backgroundTasks.Remove(completed);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private async Task DrainBackgroundTasksAsync()
    {
        while (true)
        {
            Task[] tasks;
            lock (_stateGate)
            {
                tasks = [.. _backgroundTasks];
            }
            if (tasks.Length == 0)
            {
                return;
            }

            try
            {
                await Task.WhenAll(tasks).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Server shutdown owns cancellation of tracked transport work.
            }
            finally
            {
                lock (_stateGate)
                {
                    foreach (var task in tasks)
                    {
                        if (task.IsCompleted)
                        {
                            _backgroundTasks.Remove(task);
                        }
                    }
                }
            }
        }
    }

    private int SocketCount()
    {
        lock (_stateGate)
        {
            return sockets.Count;
        }
    }

    private void LogOutbound(string operation, string type, object? data)
    {
        if (_logPayloads)
        {
            _log([operation, type, data]);
        }
    }

    private void EnsureNotStarted()
    {
        if (_started || _stopTask is { IsCompleted: false })
        {
            throw new InvalidOperationException("The transport cannot change after the server starts.");
        }
    }

    private static IPAddress ResolveBindAddress(string host, AddressFamily? preferredFamily)
    {
        if (IPAddress.TryParse(host, out var literal))
        {
            return literal;
        }

        var addresses = Dns.GetHostAddresses(host);
        var selected = preferredFamily is null
            ? addresses.FirstOrDefault()
            : addresses.FirstOrDefault(address => address.AddressFamily == preferredFamily);
        return selected ?? throw new SocketException((int)SocketError.HostNotFound);
    }
}
