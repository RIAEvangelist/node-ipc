using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using NodeIpc;

const int expectedCases = 45;
var tests = new (string Name, Func<Task> Run)[]
{
    ("defaults match the JavaScript profile", DefaultsMatchJavaScript),
    ("Fast encodes the exact canonical empty envelope", FastEncodesCanonicalEnvelope),
    ("Fast preserves explicit null, false, zero, empty, array, and Unicode payloads", FastPreservesPayloadShapes),
    ("Fast splits ordered frames and retains a trailing fragment", FastSplitsAndRetains),
    ("a multibyte delimiter survives fragmented reads", MultibyteDelimiterFragments),
    ("invalid JSON maps to ERR_IPC_INVALID_JSON", InvalidJsonCode),
    ("Fast retains a missing data member for dispatch", FastMissingData),
    ("parser format, push, parse, and message compatibility helpers mirror JavaScript", ParserHelpers),
    ("a minimal custom parser only needs encode and read", MinimalCustomParserWorks),
    ("Guarded rejects lifecycle and Object prototype event names", GuardedRejectsUnsafeNames),
    ("Guarded can allow reserved lifecycle names", GuardedAllowsReservedNames),
    ("Guarded enforces the exact UTF-8 frame boundary", GuardedFrameBoundary),
    ("Guarded measures event names as UTF-16 code units", GuardedUtf16NameLimit),
    ("Assured requires and enforces a copied allowlist", AssuredAllowlist),
    ("Raw preserves arbitrary bytes", RawPreservesBytes),
    ("event dispatch is wildcard-first and registration-ordered", EventOrdering),
    ("publishing the wildcard event dispatches its bucket once", EventWildcardSelf),
    ("once is removed before a reentrant publish", EventOnceReentrant),
    ("off and list snapshots do not disturb unrelated handlers", EventOffAndSnapshot),
    ("service overloads retain JavaScript endpoint defaults", ServiceOverloads),
    ("parser selection is captured when a service is created", ParserSelectionCaptured),
    ("TCP performs a framed request and targeted response", TcpRoundTrip),
    ("TCP broadcasts to multiple clients", TcpBroadcast),
    ("Raw TCP preserves invalid UTF-8 and delimiter bytes", RawTcpRoundTrip),
    ("UDP4 performs a framed peer exchange", UdpRoundTrip),
    ("Raw UDP4 preserves one datagram payload", RawUdpRoundTrip),
    ("local Unix socket or Windows pipe performs a framed exchange", LocalRoundTrip),
    ("a client reconnects when the server appears", ClientReconnects),
    ("a malformed Fast envelope stops client retries", FastMalformedStopsRetries),
    ("the connect callback can queue a write before the socket opens", PreConnectCallbackQueuesWrite),
    ("Fast soft backpressure reports false without dropping the queued frame", FastSoftBackpressure),
    ("disconnect completes a waiter when no connection was established", DisconnectCompletesWaiter),
    ("sync queues the second request until the first response", SyncQueuesRequests),
    ("sync does not bank an unsolicited response as future credit", SyncDoesNotBankCredit),
    ("sync advances once for every message decoded from one read", SyncAdvancesEveryDecodedMessage),
    ("Guarded closes an incomplete message after messageTimeout", GuardedMessageTimeout),
    ("a UDP sender can recover after an incomplete-frame timeout", UdpTimeoutRecovery),
    ("Guarded backpressure closes a client write queue", GuardedBackpressure),
    ("TLS performs an authenticated framed exchange", TlsRoundTrip),
    ("TLS rejects a custom-root certificate for the wrong hostname", TlsRejectsWrongHostname),
    ("Assured TLS rejects validation callbacks and identities without private keys", AssuredTlsConfigurationGates),
    ("post-construction TLS mutation cannot disable verification", TlsConfigurationSnapshot),
    ("Assured mTLS rejects an untrusted client and accepts a trusted client", AssuredMutualTls),
    ("Assured rejects unauthenticated network and Windows-local transports", AssuredTransportGates),
    ("server stop publishes close for each active stream", ServerStopPublishesClose)
};

if (tests.Length != expectedCases)
{
    throw new InvalidOperationException($"Expected {expectedCases} tests, registered {tests.Length}.");
}

var failures = new List<string>();
foreach (var test in tests)
{
    try
    {
        await test.Run().WaitAsync(TimeSpan.FromSeconds(15));
        Console.WriteLine($"PASS {test.Name}");
    }
    catch (Exception error)
    {
        failures.Add(test.Name);
        Console.Error.WriteLine($"FAIL {test.Name}\n{error}");
    }
}

Console.WriteLine($"{tests.Length - failures.Count}/{tests.Length} C# cases passed");
return failures.Count == 0 ? 0 : 1;

static Task DefaultsMatchJavaScript()
{
    var config = new Defaults();
    Equal("app.", config.appspace);
    Equal("utf8", config.encoding);
    Equal("fast", config.parser);
    Equal("\f", config.delimiter);
    Equal(1024L * 1024, config.maxMessageSize);
    Equal(8L * 1024 * 1024, config.maxPendingBytes);
    Equal(256, config.maxEventNameLength);
    Equal(30_000, config.messageTimeout);
    Equal(500, config.retry);
    Equal(8000, config.networkPort);
    Equal(100, config.maxConnections);
    True(config.secureSocketRoot);
    return Task.CompletedTask;
}

static Task FastEncodesCanonicalEnvelope()
{
    var parser = new FastParser();
    Equal("{\"type\":\"hello\",\"data\":{}}\f", Encoding.UTF8.GetString(parser.encode("hello")));
    return Task.CompletedTask;
}

static Task FastPreservesPayloadShapes()
{
    var parser = new FastParser();
    var values = new object?[] { null, false, 0, string.Empty, new[] { 1, 2 }, "héllo 🌍" };
    foreach (var value in values)
    {
        var frame = parser.encode("shape", value);
        var message = parser.decode(frame.AsSpan(0, frame.Length - 1));
        True(message.hasData);
        using var expected = JsonDocument.Parse(JsonSerializer.Serialize(value));
        Equal(expected.RootElement.ToString(), message.data!.Value.ToString());
    }
    return Task.CompletedTask;
}

static Task FastSplitsAndRetains()
{
    var parser = new FastParser();
    var first = parser.encode("one", 1);
    var second = parser.encode("two", 2);
    var partial = parser.encode("three", 3)[..8];
    var combined = first.Concat(second).Concat(partial).ToArray();
    var buffer = new FrameBuffer();
    var types = new List<string>();
    parser.read(buffer, combined, message => types.Add(message.type));
    SequenceEqual(new[] { "one", "two" }, types);
    Equal(partial.Length, buffer.length);
    return Task.CompletedTask;
}

static Task MultibyteDelimiterFragments()
{
    var config = new Defaults { delimiter = "💥" };
    var parser = new FastParser(config);
    var frame = parser.encode("boom", true);
    var buffer = new FrameBuffer();
    IpcMessage? received = null;
    parser.read(buffer, frame.AsSpan(0, frame.Length - 2), message => received = message);
    True(received is null);
    parser.read(buffer, frame.AsSpan(frame.Length - 2), message => received = message);
    Equal("boom", received!.type);
    return Task.CompletedTask;
}

static Task InvalidJsonCode()
{
    var error = Throws<IPCProtocolException>(() => new FastParser().decode("{"u8));
    Equal(IPCProtocolCodes.InvalidJson, error.Code);
    return Task.CompletedTask;
}

static Task FastMissingData()
{
    var message = new FastParser().decode("{\"type\":\"missing\"}"u8);
    Equal("missing", message.type);
    True(!message.hasData);
    True(message.data is null);
    return Task.CompletedTask;
}

static Task ParserHelpers()
{
    var parser = new Parser(new Defaults { delimiter = "|" });
    var pushed = parser.push("one|par", "tial|tail");
    SequenceEqual(new[] { "one", "partial" }, pushed.events);
    Equal("tail", pushed.remainder);
    SequenceEqual(new[] { "a", "b" }, parser.parse("a|b|"));

    var message = new IpcMessage("format", JsonSerializer.SerializeToElement(new { ok = true }));
    Equal(
        Encoding.UTF8.GetString(parser.encode("format", message.data)),
        Encoding.UTF8.GetString(parser.format(message)));
    Equal(
        "{\"type\":\"missing\",\"data\":{}}|",
        Encoding.UTF8.GetString(parser.format(new IpcMessage("missing", null, hasData: false))));

    var guarded = new GuardedParser(new Defaults { delimiter = "|", maxMessageSize = 3 });
    Equal(IPCProtocolCodes.FrameTooLarge,
        Throws<IPCProtocolException>(() => guarded.push(string.Empty, "four|")).Code);

    var raw = new RawParser();
    var bytes = new byte[] { 0, 0xff, 1 };
    SequenceEqual(bytes, raw.format(bytes));
    SequenceEqual(bytes, raw.parse(bytes)[0]);

    var invalid = new MessageParser().decode("not-json"u8);
    Equal("error", invalid.type);
    Equal("Invalid JSON response format", invalid.data!.Value.GetProperty("message").GetString());
    return Task.CompletedTask;
}

static Task MinimalCustomParserWorks()
{
    var config = new Defaults { parserInstance = new MinimalParser() };
    var parser = ParserFactory.create(config);
    Equal("custom", parser.profile);
    IpcMessage? received = null;
    parser.read(new FrameBuffer(), "anything"u8, message => received = message);
    Equal("custom", received!.type);
    Equal("sample", Encoding.UTF8.GetString(parser.encode("sample")));
    return Task.CompletedTask;
}

static Task GuardedRejectsUnsafeNames()
{
    var parser = new GuardedParser();
    Equal(IPCProtocolCodes.ReservedEvent, Throws<IPCProtocolException>(() => parser.encode("connect")).Code);
    Equal(IPCProtocolCodes.InvalidEvent, Throws<IPCProtocolException>(() => parser.encode("__proto__")).Code);
    return Task.CompletedTask;
}

static Task GuardedAllowsReservedNames()
{
    var parser = new GuardedParser(new Defaults { allowReservedEvents = true });
    True(parser.encode("connect").Length > 0);
    return Task.CompletedTask;
}

static Task GuardedFrameBoundary()
{
    var fast = new FastParser();
    var exact = fast.encode("size", "x");
    var payloadBytes = exact.Length - 1;
    var accepted = new GuardedParser(new Defaults { maxMessageSize = payloadBytes });
    accepted.encode("size", "x");
    var rejected = new GuardedParser(new Defaults { maxMessageSize = payloadBytes - 1 });
    Equal(IPCProtocolCodes.FrameTooLarge, Throws<IPCProtocolException>(() => rejected.encode("size", "x")).Code);
    return Task.CompletedTask;
}

static Task GuardedUtf16NameLimit()
{
    var parser = new GuardedParser(new Defaults { maxEventNameLength = 2 });
    parser.encode("😀");
    Equal(IPCProtocolCodes.EventTooLarge, Throws<IPCProtocolException>(() => parser.encode("😀x")).Code);
    return Task.CompletedTask;
}

static Task AssuredAllowlist()
{
    Throws<ArgumentException>(() => new AssuredParser());
    var allowed = new HashSet<string>(StringComparer.Ordinal) { "allowed" };
    var parser = new AssuredParser(new Defaults { allowedEvents = allowed });
    allowed.Add("late");
    parser.encode("allowed", 1);
    Equal(IPCProtocolCodes.EventNotAllowed, Throws<IPCProtocolException>(() => parser.encode("late", 2)).Code);
    return Task.CompletedTask;
}

static Task RawPreservesBytes()
{
    var parser = new RawParser();
    var bytes = new byte[] { 0, 0xff, 0x0c, 1 };
    SequenceEqual(bytes, parser.encode(bytes));
    return Task.CompletedTask;
}

static Task EventOrdering()
{
    var endpoint = new ProbeEndpoint();
    var seen = new List<string>();
    endpoint.on("*", arguments => seen.Add($"wild:{arguments[0]}"));
    endpoint.on("work", () => seen.Add("typed:first"));
    endpoint.on("work", () => seen.Add("typed:second"));
    endpoint.raise("work");
    SequenceEqual(new[] { "wild:work", "typed:first", "typed:second" }, seen);
    return Task.CompletedTask;
}

static Task EventWildcardSelf()
{
    var endpoint = new ProbeEndpoint();
    var calls = 0;
    object?[]? seen = null;
    endpoint.on("*", arguments =>
    {
        calls++;
        seen = arguments;
    });
    endpoint.raise("*", 7);
    Equal(1, calls);
    Equal("*", seen![0]);
    Equal(7, seen[1]);
    return Task.CompletedTask;
}

static Task EventOnceReentrant()
{
    var endpoint = new ProbeEndpoint();
    var calls = 0;
    endpoint.once("work", () =>
    {
        calls++;
        endpoint.raise("work");
    });
    endpoint.raise("work");
    Equal(1, calls);
    return Task.CompletedTask;
}

static Task EventOffAndSnapshot()
{
    var endpoint = new ProbeEndpoint();
    var calls = 0;
    Action removed = () => calls++;
    endpoint.on("work", removed);
    endpoint.on("work", () => calls += 10);
    var snapshot = endpoint.list;
    endpoint.off("work", removed);
    endpoint.raise("work");
    Equal(10, calls);
    Equal(2, snapshot["work"].Count);
    return Task.CompletedTask;
}

static async Task ServiceOverloads()
{
    await using var ipc = new IPCModule();
    ipc.config.socketRoot = "root/";
    ipc.config.appspace = "scope.";
    ipc.config.id = "service";
    ipc.config.networkHost = "127.0.0.9";
    ipc.config.networkPort = 9010;
    Equal("root/scope.service", ipc.serve().path);
    var udp = ipc.serveNet("udp4");
    True(udp.udp4);
    Equal("127.0.0.9", udp.path);
    Equal(9010, udp.port);
    var tcp = ipc.serveNet(9020);
    Equal("127.0.0.9", tcp.path);
    Equal(9020, tcp.port);
    Equal("root/scope.service", ipc.serve(string.Empty).path);
    var defaultNetwork = ipc.serveNet(string.Empty, 0);
    Equal("127.0.0.9", defaultNetwork.path);
    Equal(9010, defaultNetwork.port);
    var emptyUdpType = ipc.serveNet("127.0.0.1", string.Empty);
    True(!emptyUdpType.udp4 && !emptyUdpType.udp6);
    Equal(9010, emptyUdpType.port);
    True(ipc.connectTo(string.Empty) is null);
    var localClient = ipc.connectTo("local", string.Empty)!;
    Equal("root/scope.local", localClient.path);
    ipc.disconnect("local");
    var networkClient = ipc.connectToNet("network", string.Empty, 0)!;
    Equal("127.0.0.9", networkClient.path);
    Equal(9010, networkClient.port);
    ipc.disconnect("network");
}

static async Task ParserSelectionCaptured()
{
    await using var ipc = new IPCModule();
    ipc.config.parser = "guarded";
    var server = ipc.serve("capture");
    ipc.config.parser = "fast";
    Equal("guarded", server.parser.profile);
}

static async Task TcpRoundTrip()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.on<JsonElement>("request", (data, peer) => server.emit(peer, "response", data));
    server.start();
    await using var clientIpc = NetworkIpc(port);
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    var response = NewSource<JsonElement>();
    client.on<JsonElement>("response", data => response.TrySetResult(data));
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    True(client.emit("request", new { value = 42 }));
    Equal(42, (await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("value").GetInt32());
}

static async Task TcpBroadcast()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.start();
    await using var firstIpc = NetworkIpc(port);
    await using var secondIpc = NetworkIpc(port);
    var first = firstIpc.connectToNet("server", "127.0.0.1", port)!;
    var second = secondIpc.connectToNet("server", "127.0.0.1", port)!;
    var firstData = NewSource<JsonElement>();
    var secondData = NewSource<JsonElement>();
    first.on<JsonElement>("broadcast", data => firstData.TrySetResult(data));
    second.on<JsonElement>("broadcast", data => secondData.TrySetResult(data));
    await Task.WhenAll(first.waitForConnectAsync(), second.waitForConnectAsync()).WaitAsync(TimeSpan.FromSeconds(5));
    await WaitUntil(() => server.sockets.Count == 2);
    True(server.broadcast("broadcast", new { ok = true }));
    True((await firstData.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("ok").GetBoolean());
    True((await secondData.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("ok").GetBoolean());
}

static async Task RawTcpRoundTrip()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port, raw: true);
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.on<byte[]>("data", (data, peer) => server.emit(peer, data));
    server.start();
    await using var clientIpc = NetworkIpc(port, raw: true);
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    var received = NewSource<byte[]>();
    client.on<byte[]>("data", data => received.TrySetResult(data));
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    var payload = new byte[] { 0xff, 0, 0x0c, 0xfe };
    True(client.emit(payload));
    SequenceEqual(payload, await received.Task.WaitAsync(TimeSpan.FromSeconds(5)));
}

static async Task UdpRoundTrip()
{
    var firstPort = ReserveUdpPort();
    var secondPort = ReserveUdpPort();
    await using var firstIpc = NetworkIpc(firstPort);
    await using var secondIpc = NetworkIpc(secondPort);
    var first = firstIpc.serveNet("127.0.0.1", firstPort, "udp4");
    var second = secondIpc.serveNet("127.0.0.1", secondPort, "udp4");
    var response = NewSource<JsonElement>();
    first.on<JsonElement>("ping", (data, peer) => first.emit(peer, "pong", data));
    second.on<JsonElement>("pong", (data, _) => response.TrySetResult(data));
    first.start();
    second.start();
    True(second.emit(second.peer("localhost", firstPort), "ping", new { value = 7 }));
    Equal(7, (await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("value").GetInt32());
}

static async Task RawUdpRoundTrip()
{
    var firstPort = ReserveUdpPort();
    var secondPort = ReserveUdpPort();
    await using var firstIpc = NetworkIpc(firstPort, raw: true);
    await using var secondIpc = NetworkIpc(secondPort, raw: true);
    var first = firstIpc.serveNet("127.0.0.1", firstPort, "udp4");
    var second = secondIpc.serveNet("127.0.0.1", secondPort, "udp4");
    var response = NewSource<byte[]>();
    first.on<byte[]>("data", (data, peer) => first.emit(peer, data));
    second.on<byte[]>("data", (data, _) => response.TrySetResult(data));
    first.start();
    second.start();
    var payload = new byte[] { 0, 0xff, 0x0c, 4 };
    True(second.emit(second.peer("127.0.0.1", firstPort), payload));
    SequenceEqual(payload, await response.Task.WaitAsync(TimeSpan.FromSeconds(5)));
}

static async Task LocalRoundTrip()
{
    var fixture = LocalFixture();
    try
    {
        await using var serverIpc = fixture.Server;
        var server = serverIpc.serve(fixture.Endpoint);
        server.on<JsonElement>("request", (data, peer) => server.emit(peer, "response", data));
        server.start();
        await using var clientIpc = fixture.Client;
        var client = clientIpc.connectTo("server", fixture.Endpoint)!;
        var response = NewSource<JsonElement>();
        client.on<JsonElement>("response", data => response.TrySetResult(data));
        await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
        client.emit("request", new { local = true });
        True((await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("local").GetBoolean());
    }
    finally
    {
        fixture.Cleanup();
    }
}

static async Task ClientReconnects()
{
    var port = ReservePort();
    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.stopRetrying = false;
    clientIpc.config.maxRetries = 20;
    clientIpc.config.retry = 25;
    var client = clientIpc.connectToNet("late", "127.0.0.1", port)!;
    await Task.Delay(100);
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.start();
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    True(client.socket is { destroyed: false });
}

static async Task FastMalformedStopsRetries()
{
    var port = ReservePort();
    var listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    var served = Task.Run(async () =>
    {
        using var accepted = await listener.AcceptTcpClientAsync();
        await accepted.GetStream().WriteAsync("{}\f"u8.ToArray());
    });

    await using var ipc = NetworkIpc(port);
    ipc.config.stopRetrying = false;
    ipc.config.maxRetries = 20;
    ipc.config.retry = 10;
    var client = ipc.connectToNet("malformed", "127.0.0.1", port)!;
    var failure = NewSource<IPCProtocolException>();
    client.on<Exception>("error", error =>
    {
        if (error is IPCProtocolException protocol)
        {
            failure.TrySetResult(protocol);
        }
    });
    try
    {
        Equal(IPCProtocolCodes.InvalidMessage,
            (await failure.Task.WaitAsync(TimeSpan.FromSeconds(5))).Code);
        await served.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(75);
        True(client.protocolViolation);
        True(!client.active);
    }
    finally
    {
        listener.Stop();
    }
}

static async Task PreConnectCallbackQueuesWrite()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var received = NewSource<JsonElement>();
    server.on<JsonElement>("early", (data, _) => received.TrySetResult(data));

    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.stopRetrying = false;
    clientIpc.config.maxRetries = 40;
    clientIpc.config.retry = 25;
    var queued = NewSource<bool>();
    var client = clientIpc.connectToNet(
        "server",
        "127.0.0.1",
        port,
        () => queued.TrySetResult(clientIpc.of["server"].emit("early", new { queued = true })))!;
    True(await queued.Task);
    server.start();
    True((await received.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("queued").GetBoolean());
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
}

static async Task FastSoftBackpressure()
{
    var port = ReservePort();
    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.stopRetrying = false;
    clientIpc.config.maxRetries = 40;
    clientIpc.config.retry = 25;
    var client = clientIpc.connectToNet("late", "127.0.0.1", port)!;
    var firstPayload = new string('a', 9_000);
    var secondPayload = new string('b', 9_000);
    True(client.emit("large", firstPayload));
    True(!client.emit("large", secondPayload));

    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var received = NewSource<IReadOnlyList<string>>();
    var values = new List<string>();
    server.on<JsonElement>("large", (data, _) =>
    {
        values.Add(data.GetString()!);
        if (values.Count == 2)
        {
            received.TrySetResult(values.ToArray());
        }
    });
    server.start();
    SequenceEqual(
        new[] { firstPayload, secondPayload },
        await received.Task.WaitAsync(TimeSpan.FromSeconds(5)));
}

static async Task DisconnectCompletesWaiter()
{
    var port = ReservePort();
    await using var ipc = NetworkIpc(port);
    ipc.config.stopRetrying = false;
    ipc.config.maxRetries = long.MaxValue;
    ipc.config.retry = 25;
    var client = ipc.connectToNet("never", "127.0.0.1", port)!;
    var waiter = client.waitForConnectAsync();
    var pendingWrite = client.emitAsync("queued", 1);
    await WaitUntil(() => client.retryTimer);
    await client.disconnectAsync();
    await ExpectIOException(waiter);
    await ExpectIOException(pendingWrite);
}

static async Task SyncQueuesRequests()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var requests = 0;
    var firstRequest = NewSource<IpcPeer>();
    var secondRequest = NewSource<bool>();
    server.on<JsonElement>("request", (_, peer) =>
    {
        requests++;
        if (requests == 1)
        {
            firstRequest.TrySetResult(peer);
        }
        else
        {
            server.emit(peer, "response", requests);
            secondRequest.TrySetResult(true);
        }
    });
    server.start();
    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.sync = true;
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    client.emit("request", 1);
    client.emit("request", 2);
    var peer = await firstRequest.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await Task.Delay(100);
    Equal(1, requests);
    server.emit(peer, "response", 1);
    await secondRequest.Task.WaitAsync(TimeSpan.FromSeconds(5));
    Equal(2, requests);
}

static async Task SyncDoesNotBankCredit()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var connectedPeer = NewSource<IpcPeer>();
    server.on<IpcPeer>("connect", peer => connectedPeer.TrySetResult(peer));
    var requests = 0;
    var first = NewSource<IpcPeer>();
    var second = NewSource<bool>();
    server.on<JsonElement>("request", (_, peer) =>
    {
        requests++;
        if (requests == 1)
        {
            first.TrySetResult(peer);
        }
        else
        {
            second.TrySetResult(true);
        }
    });
    server.start();

    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.sync = true;
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    var notice = NewSource<bool>();
    client.on<JsonElement>("notice", data => notice.TrySetResult(data.GetBoolean()));
    var peerForNotice = await connectedPeer.Task.WaitAsync(TimeSpan.FromSeconds(5));
    server.emit(peerForNotice, "notice", true);
    True(await notice.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    client.emit("request", 1);
    client.emit("request", 2);
    var peer = await first.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await Task.Delay(100);
    Equal(1, requests);
    server.emit(peer, "response", 1);
    await second.Task.WaitAsync(TimeSpan.FromSeconds(5));
}

static async Task SyncAdvancesEveryDecodedMessage()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port, raw: true);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var byteCount = 0;
    var allRequests = NewSource<bool>();
    server.on<byte[]>("data", (data, peer) =>
    {
        var wasEmpty = byteCount == 0;
        byteCount += data.Length;
        if (wasEmpty)
        {
            server.emit(peer, new byte[] { 1 });
        }
        if (byteCount >= 3)
        {
            allRequests.TrySetResult(true);
        }
    });
    server.start();

    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.sync = true;
    clientIpc.config.parserInstance = new DoubleAckParser();
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    True(client.emit("one"));
    True(client.emit("two"));
    True(client.emit("three"));
    True(await allRequests.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    Equal(3, byteCount);
}

static async Task GuardedMessageTimeout()
{
    var port = ReservePort();
    await using var ipc = NetworkIpc(port);
    ipc.config.parser = "guarded";
    ipc.config.messageTimeout = 50;
    var server = ipc.serveNet("127.0.0.1", port);
    var failure = NewSource<IPCProtocolException>();
    server.on<Exception>("error", error =>
    {
        if (error is IPCProtocolException protocol)
        {
            failure.TrySetResult(protocol);
        }
    });
    server.start();
    using var client = new TcpClient();
    await client.ConnectAsync(IPAddress.Loopback, port);
    await client.GetStream().WriteAsync("{\"type\":\"partial\""u8.ToArray());
    Equal(IPCProtocolCodes.MessageTimeout,
        (await failure.Task.WaitAsync(TimeSpan.FromSeconds(5))).Code);
}

static async Task UdpTimeoutRecovery()
{
    var port = ReserveUdpPort();
    await using var ipc = NetworkIpc(port);
    ipc.config.parser = "guarded";
    ipc.config.messageTimeout = 50;
    var server = ipc.serveNet("127.0.0.1", port, "udp4");
    var failure = NewSource<IPCProtocolException>();
    var recovered = NewSource<JsonElement>();
    server.on<Exception>("error", error =>
    {
        if (error is IPCProtocolException protocol)
        {
            failure.TrySetResult(protocol);
        }
    });
    server.on<JsonElement>("recovered", (data, _) => recovered.TrySetResult(data));
    server.start();

    using var sender = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
    var endpoint = new IPEndPoint(IPAddress.Loopback, port);
    await sender.SendAsync("{\"type\":\"partial\""u8.ToArray(), endpoint);
    Equal(IPCProtocolCodes.MessageTimeout,
        (await failure.Task.WaitAsync(TimeSpan.FromSeconds(5))).Code);
    var frame = new GuardedParser().encode("recovered", 9);
    await sender.SendAsync(frame, endpoint);
    Equal(9, (await recovered.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetInt32());
}

static async Task GuardedBackpressure()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.start();
    await using var clientIpc = NetworkIpc(port);
    clientIpc.config.parser = "guarded";
    clientIpc.config.maxPendingBytes = 1;
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    var failure = NewSource<IPCProtocolException>();
    client.on<Exception>("error", error =>
    {
        if (error is IPCProtocolException protocol)
        {
            failure.TrySetResult(protocol);
        }
    });
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    True(!client.emit("large", "payload"));
    Equal(IPCProtocolCodes.Backpressure,
        (await failure.Task.WaitAsync(TimeSpan.FromSeconds(5))).Code);
}

static async Task TlsRoundTrip()
{
    using var certificates = TestCertificates.Create();
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    serverIpc.config.tls = new TlsOptions { certificate = certificates.Server };
    var server = serverIpc.serveNet("127.0.0.1", port);
    var serverFailure = NewSource<Exception>();
    server.on<Exception>("error", error => serverFailure.TrySetResult(error));
    server.on<JsonElement>("secure", (data, peer) => server.emit(peer, "secure.reply", data));
    server.start();
    await using var clientIpc = NetworkIpc(port);
    var tls = new TlsOptions { targetHost = "localhost" };
    tls.trustedCertificates.Add(certificates.Root);
    clientIpc.config.tls = tls;
    var client = clientIpc.connectToNet("secure", "127.0.0.1", port)!;
    var response = NewSource<JsonElement>();
    var failure = NewSource<Exception>();
    client.on<Exception>("error", error => failure.TrySetResult(error));
    client.on<JsonElement>("secure.reply", data => response.TrySetResult(data));
    try
    {
        await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    }
    catch (Exception) when (failure.Task.IsCompletedSuccessfully)
    {
        var cause = serverFailure.Task.IsCompletedSuccessfully
            ? await serverFailure.Task
            : await failure.Task;
        throw new InvalidOperationException("TLS client failed to connect.", cause);
    }
    client.emit("secure", new { ok = true });
    True((await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("ok").GetBoolean());
}

static async Task TlsRejectsWrongHostname()
{
    using var certificates = TestCertificates.Create();
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    serverIpc.config.tls = new TlsOptions { certificate = certificates.Server };
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.on<Exception>("error", _ => { });
    server.start();

    await using var clientIpc = NetworkIpc(port);
    var tls = new TlsOptions { targetHost = "wrong.example" };
    tls.trustedCertificates.Add(certificates.Root);
    clientIpc.config.tls = tls;
    var client = clientIpc.connectToNet("wrong-host", "127.0.0.1", port)!;
    var failure = NewSource<Exception>();
    client.on<Exception>("error", error => failure.TrySetResult(error));
    await ExpectFailure(client.waitForConnectAsync());
    var error = await failure.Task.WaitAsync(TimeSpan.FromSeconds(5));
    True(error is AuthenticationException or IOException);
}

static async Task AssuredTlsConfigurationGates()
{
    using var certificates = TestCertificates.Create();
    var port = ReservePort();

    await using var callbackIpc = AssuredIpc(port);
    var callbackTls = new TlsOptions
    {
        certificate = certificates.Client,
        rejectUnauthorized = true,
        remoteCertificateValidationCallback = (_, _, _, _) => true
    };
    callbackTls.trustedCertificates.Add(certificates.Root);
    callbackIpc.config.tls = callbackTls;
    Equal(IPCProtocolCodes.AssuredTls,
        Throws<IPCProtocolException>(() =>
            callbackIpc.connectToNet("callback", "127.0.0.1", port)).Code);

    using var publicIdentity = new X509Certificate2(
        certificates.Client.Export(X509ContentType.Cert));
    await using var missingKeyIpc = AssuredIpc(port);
    var missingKeyTls = new TlsOptions
    {
        certificate = publicIdentity,
        rejectUnauthorized = true
    };
    missingKeyTls.trustedCertificates.Add(certificates.Root);
    missingKeyIpc.config.tls = missingKeyTls;
    Equal(IPCProtocolCodes.AssuredTls,
        Throws<IPCProtocolException>(() =>
            missingKeyIpc.connectToNet("missing-key", "127.0.0.1", port)).Code);
}

static async Task TlsConfigurationSnapshot()
{
    using var certificates = TestCertificates.Create();
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    serverIpc.config.tls = new TlsOptions { certificate = certificates.Server };
    var server = serverIpc.serveNet("127.0.0.1", port);
    server.on<Exception>("error", _ => { });
    server.start();

    await using var clientIpc = NetworkIpc(port);
    var tls = new TlsOptions
    {
        targetHost = "localhost",
        rejectUnauthorized = true
    };
    clientIpc.config.tls = tls;
    var client = clientIpc.connectToNet("snapshot", "127.0.0.1", port)!;
    var failure = NewSource<Exception>();
    client.on<Exception>("error", error => failure.TrySetResult(error));

    // RunAsync begins with Task.Yield, so this mutation occurs before the handshake.
    tls.rejectUnauthorized = false;
    tls.remoteCertificateValidationCallback = (_, _, _, _) => true;
    await ExpectFailure(client.waitForConnectAsync());
    _ = await failure.Task.WaitAsync(TimeSpan.FromSeconds(5));
}

static async Task AssuredMutualTls()
{
    using var certificates = TestCertificates.Create();
    var port = ReservePort();
    await using var serverIpc = AssuredIpc(port);
    var serverTls = new TlsOptions
    {
        certificate = certificates.Server,
        requestCert = true,
        rejectUnauthorized = true
    };
    serverTls.trustedCertificates.Add(certificates.Root);
    serverIpc.config.tls = serverTls;
    var server = serverIpc.serveNet("127.0.0.1", port);
    var serverFailure = NewSource<Exception>();
    var authenticatedConnections = 0;
    server.on<Exception>("error", error => serverFailure.TrySetResult(error));
    server.on<IpcPeer>("connect", _ => Interlocked.Increment(ref authenticatedConnections));
    server.on<JsonElement>("safe", (data, peer) => server.emit(peer, "safe.reply", data));
    server.start();

    await using (var untrustedIpc = AssuredIpc(port))
    {
        var untrustedTls = new TlsOptions
        {
            certificate = certificates.UntrustedClient,
            targetHost = "localhost",
            rejectUnauthorized = true
        };
        untrustedTls.trustedCertificates.Add(certificates.Root);
        untrustedIpc.config.tls = untrustedTls;
        var untrusted = untrustedIpc.connectToNet("untrusted", "127.0.0.1", port)!;
        untrusted.on<Exception>("error", _ => { });
        try
        {
            await untrusted.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(2));
        }
        catch (IOException)
        {
            // TLS versions differ on whether the client observes the server alert during or after its handshake.
        }
        _ = await serverFailure.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await WaitUntil(() => !untrusted.active);
        Equal(0, authenticatedConnections);
        Equal(0, server.sockets.Count);
    }

    await using var trustedIpc = AssuredIpc(port);
    var trustedTls = new TlsOptions
    {
        certificate = certificates.Client,
        targetHost = "localhost",
        rejectUnauthorized = true
    };
    trustedTls.trustedCertificates.Add(certificates.Root);
    trustedIpc.config.tls = trustedTls;
    var trusted = trustedIpc.connectToNet("trusted", "127.0.0.1", port)!;
    var response = NewSource<JsonElement>();
    trusted.on<JsonElement>("safe.reply", data => response.TrySetResult(data));
    await trusted.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    await WaitUntil(() => authenticatedConnections == 1);
    Equal(1, authenticatedConnections);
    trusted.emit("safe", new { authenticated = true });
    True((await response.Task.WaitAsync(TimeSpan.FromSeconds(5)))
        .GetProperty("authenticated").GetBoolean());
}

static async Task AssuredTransportGates()
{
    var config = new Defaults
    {
        parser = "assured",
        allowedEvents = new HashSet<string> { "safe" },
        silent = true
    };
    var ipc = new IPCModule();
    ipc.config.parser = config.parser;
    ipc.config.allowedEvents = config.allowedEvents;
    ipc.config.silent = true;
    ipc.config.stopRetrying = true;
    var port = ReservePort();
    Equal(IPCProtocolCodes.AssuredTransport,
        Throws<IPCProtocolException>(() => ipc.connectToNet("plain", "127.0.0.1", port)).Code);
    if (OperatingSystem.IsWindows())
    {
        var server = ipc.serve("/assured-test");
        Equal(IPCProtocolCodes.AssuredTransport,
            Throws<IPCProtocolException>(() => server.start()).Code);
    }
    await ipc.DisposeAsync();
}

static async Task ServerStopPublishesClose()
{
    var port = ReservePort();
    await using var serverIpc = NetworkIpc(port);
    var server = serverIpc.serveNet("127.0.0.1", port);
    var closed = NewSource<IpcPeer>();
    server.on<IpcPeer>("close", peer => closed.TrySetResult(peer));
    server.start();
    await using var clientIpc = NetworkIpc(port);
    var client = clientIpc.connectToNet("server", "127.0.0.1", port)!;
    await client.waitForConnectAsync().WaitAsync(TimeSpan.FromSeconds(5));
    await WaitUntil(() => server.sockets.Count == 1);
    await server.stopAsync();
    _ = await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
}

static IPCModule NetworkIpc(int port, bool raw = false)
{
    var ipc = new IPCModule();
    ipc.config.silent = true;
    ipc.config.networkHost = "127.0.0.1";
    ipc.config.networkPort = port;
    ipc.config.stopRetrying = true;
    ipc.config.maxRetries = 0;
    ipc.config.rawBuffer = raw;
    return ipc;
}

static IPCModule AssuredIpc(int port)
{
    var ipc = NetworkIpc(port);
    ipc.config.parser = "assured";
    ipc.config.allowedEvents = new HashSet<string>(StringComparer.Ordinal)
    {
        "safe",
        "safe.reply"
    };
    return ipc;
}

static (IPCModule Server, IPCModule Client, string Endpoint, Action Cleanup) LocalFixture()
{
    var name = "node-ipc-csharp-" + Guid.NewGuid().ToString("N");
    if (OperatingSystem.IsWindows())
    {
        var server = NetworkIpc(1);
        var client = NetworkIpc(1);
        return (server, client, "/" + name, () => { });
    }

    var root = Path.Combine(Path.GetTempPath(), name);
    var endpoint = Path.Combine(root, "service.sock");
    var serverIpc = NetworkIpc(1);
    var clientIpc = NetworkIpc(1);
    serverIpc.config.socketRoot = root + Path.DirectorySeparatorChar;
    clientIpc.config.socketRoot = root + Path.DirectorySeparatorChar;
    return (serverIpc, clientIpc, endpoint, () =>
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
    );
}

static int ReservePort()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    return port;
}

static int ReserveUdpPort()
{
    using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
    return ((IPEndPoint)udp.Client.LocalEndPoint!).Port;
}

static async Task WaitUntil(Func<bool> condition)
{
    var deadline = DateTime.UtcNow.AddSeconds(5);
    while (!condition())
    {
        if (DateTime.UtcNow >= deadline)
        {
            throw new TimeoutException("Condition was not satisfied.");
        }
        await Task.Delay(10);
    }
}

static async Task ExpectIOException(Task task)
{
    try
    {
        await task.WaitAsync(TimeSpan.FromSeconds(2));
        throw new InvalidOperationException("Expected the task to fail with IOException.");
    }
    catch (IOException)
    {
        // Expected terminal client state.
    }
}

static async Task ExpectFailure(Task task)
{
    try
    {
        await task.WaitAsync(TimeSpan.FromSeconds(5));
        throw new InvalidOperationException("Expected the task to fail.");
    }
    catch (Exception error) when (error is not InvalidOperationException and not TimeoutException)
    {
        // Expected connection failure.
    }
}

static TaskCompletionSource<T> NewSource<T>() => new(TaskCreationOptions.RunContinuationsAsynchronously);

static TException Throws<TException>(Action action) where TException : Exception
{
    try
    {
        action();
    }
    catch (TException error)
    {
        return error;
    }
    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}

static void True(bool value)
{
    if (!value)
    {
        throw new InvalidOperationException("Expected true.");
    }
}

static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"Expected {expected}, received {actual}.");
    }
}

static void SequenceEqual<T>(IEnumerable<T> expected, IEnumerable<T> actual)
{
    if (!expected.SequenceEqual(actual))
    {
        throw new InvalidOperationException(
            $"Expected [{string.Join(',', expected)}], received [{string.Join(',', actual)}].");
    }
}

sealed class ProbeEndpoint : EventEndpoint
{
    public void raise(string type, params object?[] arguments) => Publish(type, arguments);
}

sealed class MinimalParser : IParser
{
    public byte[] encode(string type, object? data) => Encoding.UTF8.GetBytes(type);

    public void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive)
    {
        receive(new IpcMessage("custom", JsonSerializer.SerializeToElement(data.Length)));
    }
}

sealed class DoubleAckParser : IParser
{
    public byte[] encode(string type, object? data) => [1];

    public void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive)
    {
        receive(new IpcMessage("ack", JsonSerializer.SerializeToElement(1)));
        receive(new IpcMessage("ack", JsonSerializer.SerializeToElement(2)));
    }
}

sealed class TestCertificates : IDisposable
{
    private TestCertificates(
        X509Certificate2 root,
        X509Certificate2 server,
        X509Certificate2 client,
        X509Certificate2 untrustedRoot,
        X509Certificate2 untrustedClient)
    {
        Root = root;
        Server = server;
        Client = client;
        UntrustedRoot = untrustedRoot;
        UntrustedClient = untrustedClient;
    }

    public X509Certificate2 Root { get; }
    public X509Certificate2 Server { get; }
    public X509Certificate2 Client { get; }
    public X509Certificate2 UntrustedRoot { get; }
    public X509Certificate2 UntrustedClient { get; }

    public static TestCertificates Create()
    {
        var root = CreateRoot("CN=node-ipc-test-root");
        var server = CreateLeaf(root, "CN=localhost", serverIdentity: true);
        var client = CreateLeaf(root, "CN=node-ipc-test-client", serverIdentity: false);
        var untrustedRoot = CreateRoot("CN=node-ipc-untrusted-root");
        var untrustedClient = CreateLeaf(
            untrustedRoot,
            "CN=node-ipc-untrusted-client",
            serverIdentity: false);
        return new TestCertificates(root, server, client, untrustedRoot, untrustedClient);
    }

    private static X509Certificate2 CreateRoot(string subject)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            subject,
            key,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign,
            true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddHours(1));
    }

    private static X509Certificate2 CreateLeaf(
        X509Certificate2 root,
        string subject,
        bool serverIdentity)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            subject,
            key,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment,
            true));
        var usages = new OidCollection
        {
            new Oid(serverIdentity ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2")
        };
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(usages, true));
        if (serverIdentity)
        {
            var san = new SubjectAlternativeNameBuilder();
            san.AddDnsName("localhost");
            san.AddIpAddress(IPAddress.Loopback);
            request.CertificateExtensions.Add(san.Build());
        }
        using var publicCertificate = request.Create(
            root,
            DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddMinutes(30),
            RandomNumberGenerator.GetBytes(16));
        return publicCertificate.CopyWithPrivateKey(key);
    }

    public void Dispose()
    {
        Server.Dispose();
        Client.Dispose();
        UntrustedClient.Dispose();
        UntrustedRoot.Dispose();
        Root.Dispose();
    }
}
