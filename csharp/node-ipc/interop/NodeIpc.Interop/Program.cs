using System.Globalization;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using NodeIpc;

try
{
    var options = ParseArguments(args);
    var contract = LoadContract(options.Contract);
    return options.Mode switch
    {
        "server" => await RunServer(options, contract),
        "client" => await RunClient(options, contract),
        _ => throw new InvalidOperationException("unreachable mode")
    };
}
catch (Exception error)
{
    Console.Error.WriteLine($"node-ipc C# behavioral peer: {error}");
    return 1;
}

static PeerOptions ParseArguments(string[] arguments)
{
    var mode = string.Empty;
    var host = "127.0.0.1";
    var port = 0;
    var contract = string.Empty;
    var json = false;

    for (var index = 0; index < arguments.Length; index++)
    {
        var argument = arguments[index];
        if (argument == "--json")
        {
            json = true;
            continue;
        }

        if (++index >= arguments.Length)
        {
            throw new ArgumentException($"{argument} requires a value.");
        }

        var value = arguments[index];
        switch (argument)
        {
            case "--mode":
                mode = value;
                break;
            case "--host":
                host = value;
                break;
            case "--port":
                if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out port) ||
                    port is < 1 or > 65535)
                {
                    throw new ArgumentException("--port must be from 1 through 65535.");
                }
                break;
            case "--contract":
                contract = value;
                break;
            default:
                throw new ArgumentException($"Unknown option: {argument}.");
        }
    }

    if (mode is not ("server" or "client"))
    {
        throw new ArgumentException("--mode must be server or client.");
    }
    if (host.Length == 0)
    {
        throw new ArgumentException("--host must not be empty.");
    }
    if (port == 0)
    {
        throw new ArgumentException("--port is required.");
    }
    if (contract.Length == 0)
    {
        throw new ArgumentException("--contract is required.");
    }
    if (!json)
    {
        throw new ArgumentException("--json is required for the behavioral peer.");
    }

    return new PeerOptions(mode, host, port, Path.GetFullPath(contract));
}

static BehaviorContract LoadContract(string file)
{
    using var document = JsonDocument.Parse(
        File.ReadAllBytes(file),
        new JsonDocumentOptions { MaxDepth = 64 });
    var root = document.RootElement;
    ValidatePortableJson(root, "contract");
    var schema = RequiredString(root, "schema");
    Equal("node-ipc-behavior-v1", schema);
    Equal("fast", RequiredString(root, "profile"));
    Equal("0c", RequiredString(root, "delimiterHex"));

    var wireProbe = root.GetProperty("wireProbe");
    var wireType = RequiredString(wireProbe, "type");
    var wireData = wireProbe.GetProperty("data");
    var expectedFrame = Encoding.UTF8.GetBytes(RequiredString(wireProbe, "frame"));
    var actualFrame = new FastParser().encode(wireType, wireData);
    if (!actualFrame.AsSpan().SequenceEqual(expectedFrame))
    {
        throw new InvalidDataException("Fast encoder changed the canonical wire probe.");
    }

    var stepsElement = root.GetProperty("steps");
    if (stepsElement.ValueKind != JsonValueKind.Array || stepsElement.GetArrayLength() == 0)
    {
        throw new InvalidDataException("The behavior contract requires at least one step.");
    }

    var exchanges = new List<BehaviorExchange>();
    foreach (var step in stepsElement.EnumerateArray())
    {
        var data = step.GetProperty("data").Clone();
        exchanges.Add(new BehaviorExchange(
            RequiredString(step, "id"),
            RequiredString(step, "request"),
            data,
            RequiredString(step, "response"),
            data.Clone()));
    }

    var finish = root.GetProperty("finish");
    var finishRequest = finish.GetProperty("requestData").Clone();
    var finishResponse = finish.GetProperty("responseData").Clone();
    Equal(exchanges.Count, finishRequest.GetProperty("expected").GetInt32());
    Equal(exchanges.Count, finishResponse.GetProperty("received").GetInt32());
    exchanges.Add(new BehaviorExchange(
        RequiredString(finish, "id"),
        RequiredString(finish, "request"),
        finishRequest,
        RequiredString(finish, "response"),
        finishResponse));

    var ids = new HashSet<string>(StringComparer.Ordinal);
    var requests = new HashSet<string>(StringComparer.Ordinal);
    var responses = new HashSet<string>(StringComparer.Ordinal);
    foreach (var exchange in exchanges)
    {
        if (!ids.Add(exchange.Id))
        {
            throw new InvalidDataException($"Duplicate behavior id: {exchange.Id}.");
        }
        if (!requests.Add(exchange.Request))
        {
            throw new InvalidDataException($"Duplicate request event: {exchange.Request}.");
        }
        if (!responses.Add(exchange.Response))
        {
            throw new InvalidDataException($"Duplicate response event: {exchange.Response}.");
        }
    }

    return new BehaviorContract(schema, stepsElement.GetArrayLength(), exchanges);
}

static async Task<int> RunServer(PeerOptions options, BehaviorContract contract)
{
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    await using var ipc = Configured(options);
    var server = ipc.serveNet(options.Host, options.Port);
    var incoming = Channel.CreateUnbounded<ReceivedRequest>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false
    });
    var requestEvents = contract.Exchanges
        .Select(exchange => exchange.Request)
        .ToHashSet(StringComparer.Ordinal);
    server.on("*", (Action<object?[]>)(eventArguments =>
    {
        var type = EventType(eventArguments);
        if (!IsServerLifecycleEvent(type) && !requestEvents.Contains(type))
        {
            incoming.Writer.TryComplete(
                new InvalidDataException($"Unexpected server event: {type}."));
        }
    }));
    var peerClosed = new TaskCompletionSource<IpcPeer>(
        TaskCreationOptions.RunContinuationsAsynchronously);

    foreach (var exchange in contract.Exchanges)
    {
        var expected = exchange;
        server.on<JsonElement, IpcPeer>(expected.Request, (data, peer) =>
        {
            if (!incoming.Writer.TryWrite(new ReceivedRequest(expected.Id, data.Clone(), peer)))
            {
                throw new IOException("The behavioral request channel is closed.");
            }
        });
    }
    server.on<Exception>("error", error => incoming.Writer.TryComplete(error));
    server.on<IpcPeer>("close", peer =>
    {
        incoming.Writer.TryComplete();
        peerClosed.TrySetResult(peer);
    });
    server.start();
    Report(options, contract, "server", "listening");

    IpcPeer? behaviorPeer = null;
    foreach (var expected in contract.Exchanges)
    {
        var received = await incoming.Reader.ReadAsync(deadline.Token);
        behaviorPeer ??= received.Peer;
        if (!ReferenceEquals(behaviorPeer, received.Peer))
        {
            throw new InvalidDataException("Behavior requests arrived from multiple peers.");
        }
        Equal(expected.Id, received.Id);
        JsonEqual(expected.RequestData, received.Data, $"request payload at {expected.Id}");
        await server.emitAsync(
            received.Peer,
            expected.Response,
            expected.ResponseData,
            deadline.Token);
    }

    var closedPeer = await peerClosed.Task.WaitAsync(deadline.Token);
    if (!ReferenceEquals(behaviorPeer, closedPeer))
    {
        throw new InvalidDataException("A different peer closed the behavior connection.");
    }
    if (closedPeer.incompleteFrameBytes != 0)
    {
        throw new InvalidDataException(
            $"Client ended with {closedPeer.incompleteFrameBytes} bytes in an incomplete trailing frame.");
    }
    if (incoming.Reader.TryRead(out var trailing))
    {
        throw new InvalidDataException(
            $"Client sent a trailing request for {trailing.Id} after the finish request.");
    }
    await incoming.Reader.Completion.WaitAsync(deadline.Token);
    await server.stopAsync().WaitAsync(deadline.Token);
    Report(options, contract, "server", "complete");
    return 0;
}

static async Task<int> RunClient(PeerOptions options, BehaviorContract contract)
{
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    await using var ipc = Configured(options);
    var client = ipc.connectToNet("behavior-server", options.Host, options.Port)!;
    var incoming = Channel.CreateUnbounded<ReceivedResponse>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false
    });
    var disconnected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var responseEvents = contract.Exchanges
        .Select(exchange => exchange.Response)
        .ToHashSet(StringComparer.Ordinal);
    client.on("*", (Action<object?[]>)(eventArguments =>
    {
        var type = EventType(eventArguments);
        if (!IsClientLifecycleEvent(type) && !responseEvents.Contains(type))
        {
            incoming.Writer.TryComplete(
                new InvalidDataException($"Unexpected client event: {type}."));
        }
    }));

    foreach (var exchange in contract.Exchanges)
    {
        var expected = exchange;
        client.on<JsonElement>(expected.Response, data =>
        {
            if (!incoming.Writer.TryWrite(new ReceivedResponse(expected.Id, data.Clone())))
            {
                throw new IOException("The behavioral response channel is closed.");
            }
        });
    }
    client.on<Exception>("error", error => incoming.Writer.TryComplete(error));
    client.on("disconnect", () =>
    {
        incoming.Writer.TryComplete();
        disconnected.TrySetResult();
    });
    await client.waitForConnectAsync(deadline.Token);

    foreach (var exchange in contract.Exchanges.Take(contract.StepCount))
    {
        await client.emitAsync(exchange.Request, exchange.RequestData, deadline.Token);
    }
    foreach (var expected in contract.Exchanges.Take(contract.StepCount))
    {
        await ReceiveResponse(incoming.Reader, expected, deadline.Token);
    }

    var finish = contract.Exchanges[contract.StepCount];
    await client.emitAsync(finish.Request, finish.RequestData, deadline.Token);
    await ReceiveResponse(incoming.Reader, finish, deadline.Token);
    ShutdownRequestStream(client);
    await disconnected.Task.WaitAsync(deadline.Token);
    if (client.socket?.incompleteFrameBytes != 0)
    {
        throw new InvalidDataException(
            $"Server ended with {client.socket?.incompleteFrameBytes} bytes in an incomplete trailing frame.");
    }
    if (incoming.Reader.TryRead(out var trailing))
    {
        throw new InvalidDataException(
            $"Server sent a trailing response for {trailing.Id} after the finish response.");
    }
    await incoming.Reader.Completion.WaitAsync(deadline.Token);

    await client.disconnectAsync().WaitAsync(deadline.Token);
    Report(options, contract, "client", "complete");
    return 0;
}

static void ShutdownRequestStream(Client client)
{
    if (client.socket?.native is not TcpClient tcpClient)
    {
        throw new InvalidDataException("The C# behavioral client has no TCP socket to half-close.");
    }
    tcpClient.Client.Shutdown(SocketShutdown.Send);
}

static string EventType(object?[] eventArguments)
{
    if (eventArguments.Length == 0 || eventArguments[0] is not string type)
    {
        throw new InvalidDataException("Wildcard event did not include an event type.");
    }
    return type;
}

static bool IsServerLifecycleEvent(string type) => type is
    "start" or "connect" or "close" or "socket.disconnected" or "error";

static bool IsClientLifecycleEvent(string type) => type is
    "connect" or "disconnect" or "destroy" or "error";

static async Task ReceiveResponse(
    ChannelReader<ReceivedResponse> incoming,
    BehaviorExchange expected,
    CancellationToken cancellationToken)
{
    var received = await incoming.ReadAsync(cancellationToken);
    Equal(expected.Id, received.Id);
    JsonEqual(expected.ResponseData, received.Data, $"response payload at {expected.Id}");
}

static IPCModule Configured(PeerOptions options)
{
    var ipc = new IPCModule();
    ipc.config.silent = true;
    ipc.config.parser = "fast";
    ipc.config.sync = false;
    ipc.config.networkHost = options.Host;
    ipc.config.networkPort = options.Port;
    ipc.config.stopRetrying = true;
    ipc.config.maxRetries = 0;
    ipc.config.maxConnections = 1;
    return ipc;
}

static void Report(
    PeerOptions options,
    BehaviorContract contract,
    string role,
    string status)
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        schema = contract.Schema,
        language = "csharp",
        role,
        status,
        host = options.Host,
        port = options.Port,
        steps = contract.StepCount,
        frames = contract.Exchanges.Count,
        scenario_ids = contract.Exchanges.Select(exchange => exchange.Id).ToArray()
    }));
    Console.Out.Flush();
}

static string RequiredString(JsonElement value, string property)
{
    if (!value.TryGetProperty(property, out var element) ||
        element.ValueKind != JsonValueKind.String ||
        string.IsNullOrEmpty(element.GetString()))
    {
        throw new InvalidDataException($"{property} must be a nonempty string.");
    }
    return element.GetString()!;
}

static void JsonEqual(JsonElement expected, JsonElement actual, string context)
{
    if (!JsonEquivalent(expected, actual))
    {
        throw new InvalidDataException(
            $"JSON mismatch for {context}: expected {expected.GetRawText()}, received {actual.GetRawText()}.");
    }
}

static bool JsonEquivalent(JsonElement left, JsonElement right)
{
    if (left.ValueKind != right.ValueKind)
    {
        return false;
    }

    switch (left.ValueKind)
    {
        case JsonValueKind.Object:
            {
                var leftProperties = left.EnumerateObject().ToArray();
                var rightProperties = right.EnumerateObject().ToArray();
                if (leftProperties.Length != rightProperties.Length)
                {
                    return false;
                }
                foreach (var property in leftProperties)
                {
                    if (!right.TryGetProperty(property.Name, out var candidate) ||
                        !JsonEquivalent(property.Value, candidate))
                    {
                        return false;
                    }
                }
                return true;
            }
        case JsonValueKind.Array:
            {
                var leftItems = left.EnumerateArray().ToArray();
                var rightItems = right.EnumerateArray().ToArray();
                return leftItems.Length == rightItems.Length &&
                    leftItems.Zip(rightItems).All(pair => JsonEquivalent(pair.First, pair.Second));
            }
        case JsonValueKind.String:
            return left.GetString() == right.GetString();
        case JsonValueKind.Number:
            return left.TryGetDecimal(out var leftDecimal) &&
                right.TryGetDecimal(out var rightDecimal) &&
                leftDecimal == rightDecimal;
        case JsonValueKind.True:
        case JsonValueKind.False:
            return left.GetBoolean() == right.GetBoolean();
        case JsonValueKind.Null:
        case JsonValueKind.Undefined:
            return true;
        default:
            return false;
    }
}

static void ValidatePortableJson(JsonElement value, string location)
{
    const long maxSafeInteger = 9_007_199_254_740_991;
    switch (value.ValueKind)
    {
        case JsonValueKind.Object:
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    ValidatePortableString(property.Name, $"{location} object member name");
                    if (!names.Add(property.Name))
                    {
                        throw new InvalidDataException(
                            $"{location} contains duplicate object member {property.Name}.");
                    }
                    ValidatePortableJson(property.Value, $"{location}.{property.Name}");
                }
                return;
            }
        case JsonValueKind.Array:
            var index = 0;
            foreach (var entry in value.EnumerateArray())
            {
                ValidatePortableJson(entry, $"{location}[{index++}]");
            }
            return;
        case JsonValueKind.Number:
            var spelling = value.GetRawText();
            if (!long.TryParse(
                    spelling,
                    NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture,
                    out var integer) ||
                integer is < -maxSafeInteger or > maxSafeInteger ||
                spelling != integer.ToString(CultureInfo.InvariantCulture))
            {
                throw new InvalidDataException(
                    $"{location} must contain only canonical safe integers.");
            }
            return;
        case JsonValueKind.String:
            ValidatePortableString(value.GetString()!, location);
            return;
        case JsonValueKind.True:
        case JsonValueKind.False:
        case JsonValueKind.Null:
            return;
        default:
            throw new InvalidDataException($"{location} is not portable JSON.");
    }
}

static void ValidatePortableString(string value, string location)
{
    for (var index = 0; index < value.Length; index++)
    {
        var character = value[index];
        if (char.IsHighSurrogate(character))
        {
            if (index + 1 >= value.Length || !char.IsLowSurrogate(value[index + 1]))
            {
                throw new InvalidDataException($"{location} contains a lone high surrogate.");
            }
            index++;
        }
        else if (char.IsLowSurrogate(character))
        {
            throw new InvalidDataException($"{location} contains a lone low surrogate.");
        }
    }
}

static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidDataException($"Expected {expected}, received {actual}.");
    }
}

sealed record PeerOptions(string Mode, string Host, int Port, string Contract);

sealed record BehaviorContract(
    string Schema,
    int StepCount,
    IReadOnlyList<BehaviorExchange> Exchanges);

sealed record BehaviorExchange(
    string Id,
    string Request,
    JsonElement RequestData,
    string Response,
    JsonElement ResponseData);

sealed record ReceivedRequest(string Id, JsonElement Data, IpcPeer Peer);

sealed record ReceivedResponse(string Id, JsonElement Data);
