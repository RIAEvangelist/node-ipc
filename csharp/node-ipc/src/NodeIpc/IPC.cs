using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace NodeIpc;

/// <summary>The JavaScript-shaped node-ipc facade.</summary>
public class IPC : IAsyncDisposable
{
    private readonly object _connectionGate = new();

    public static IPCModule Default { get; } = new();

    public Defaults config { get; } = new();
    public ConcurrentDictionary<string, Client> of { get; } = new(StringComparer.Ordinal);
    public Server? server { get; private set; }

    public void log(params object?[] arguments)
    {
        if (config.silent)
        {
            return;
        }

        var values = new string[arguments.Length];
        for (var index = 0; index < arguments.Length; index++)
        {
            values[index] = FormatLogValue(arguments[index]);
        }
        config.logger(string.Join(' ', values));
    }

    public Client? connectTo(string id) => ConnectLocal(id, null, null);
    public Client? connectTo(string id, Action callback) => ConnectLocal(id, null, callback);
    public Client? connectTo(string id, string path) => ConnectLocal(id, path, null);
    public Client? connectTo(string id, string path, Action callback) => ConnectLocal(id, path, callback);

    public Client? connectToNet(string id) => ConnectNetwork(id, null, null, null);
    public Client? connectToNet(string id, Action callback) => ConnectNetwork(id, null, null, callback);
    public Client? connectToNet(string id, int port) => ConnectNetwork(id, null, port, null);
    public Client? connectToNet(string id, int port, Action callback) => ConnectNetwork(id, null, port, callback);
    public Client? connectToNet(string id, string host) => ConnectNetwork(id, host, null, null);
    public Client? connectToNet(string id, string host, Action callback) => ConnectNetwork(id, host, null, callback);
    public Client? connectToNet(string id, string host, int port) => ConnectNetwork(id, host, port, null);
    public Client? connectToNet(string id, string host, int port, Action callback) =>
        ConnectNetwork(id, host, port, callback);

    public void disconnect(string id)
    {
        Client? client;
        lock (_connectionGate)
        {
            if (!of.TryRemove(id, out client))
            {
                return;
            }
        }

        client.disconnect(resetEvents: true);
    }

    public Server serve() => ServeLocal(null, null);
    public Server serve(Action callback) => ServeLocal(null, callback);
    public Server serve(string path) => ServeLocal(path, null);
    public Server serve(string path, Action callback) => ServeLocal(path, callback);

    public Server serveNet() => ServeNetwork(null, null, null, null);
    public Server serveNet(Action callback) => ServeNetwork(null, null, null, callback);
    public Server serveNet(int port) => ServeNetwork(null, port, null, null);
    public Server serveNet(int port, Action callback) => ServeNetwork(null, port, null, callback);
    public Server serveNet(string hostOrUdp) => ServeHostOrUdp(hostOrUdp, null);
    public Server serveNet(string hostOrUdp, Action callback) => ServeHostOrUdp(hostOrUdp, callback);
    public Server serveNet(string host, int port) => ServeNetwork(host, port, null, null);
    public Server serveNet(string host, int port, Action callback) => ServeNetwork(host, port, null, callback);
    public Server serveNet(string host, string udpType) => ServeNetwork(host, null, udpType, null);
    public Server serveNet(string host, string udpType, Action callback) =>
        ServeNetwork(host, null, udpType, callback);
    public Server serveNet(int port, string udpType) => ServeNetwork(null, port, udpType, null);
    public Server serveNet(int port, string udpType, Action callback) =>
        ServeNetwork(null, port, udpType, callback);
    public Server serveNet(string host, int port, string udpType) =>
        ServeNetwork(host, port, udpType, null);
    public Server serveNet(string host, int port, string udpType, Action callback) =>
        ServeNetwork(host, port, udpType, callback);

    public async ValueTask DisposeAsync()
    {
        KeyValuePair<string, Client>[] clients;
        lock (_connectionGate)
        {
            clients = of.ToArray();
            of.Clear();
        }
        foreach (var (_, client) in clients)
        {
            await client.disconnectAsync(resetEvents: true).ConfigureAwait(false);
        }

        if (server is not null)
        {
            await server.stopAsync().ConfigureAwait(false);
            server = null;
        }
    }

    private Client? ConnectLocal(string id, string? socketPath, Action? callback)
    {
        if (!ValidateId(id))
        {
            return null;
        }
        if (string.IsNullOrEmpty(socketPath))
        {
            socketPath = config.socketRoot + config.appspace + id;
        }
        return Connect(id, socketPath, null, callback);
    }

    private Client? ConnectNetwork(string id, string? host, int? networkPort, Action? callback)
    {
        if (!ValidateId(id))
        {
            return null;
        }
        if (string.IsNullOrEmpty(host))
        {
            host = config.networkHost;
        }
        if (networkPort is null or 0)
        {
            networkPort = config.networkPort;
        }
        return Connect(id, host, networkPort, callback);
    }

    private Client Connect(string id, string endpoint, int? networkPort, Action? callback)
    {
        Client client;
        lock (_connectionGate)
        {
            if (of.TryGetValue(id, out var existing) && existing.active && existing.socket?.destroyed != true)
            {
                log("Already Connected to", id, "- So executing success without connection");
                callback?.Invoke();
                return existing;
            }

            if (existing is not null)
            {
                existing.disconnect(resetEvents: true);
            }

            client = new Client(config, LogArguments)
            {
                id = id,
                path = endpoint,
                port = networkPort
            };
            of[id] = client;
            client.connect();
        }
        callback?.Invoke();
        return client;
    }

    private Server ServeLocal(string? socketPath, Action? callback)
    {
        if (string.IsNullOrEmpty(socketPath))
        {
            socketPath = config.socketRoot + config.appspace + config.id;
        }
        var created = new Server(socketPath, config, LogArguments);
        if (callback is not null)
        {
            created.on("start", callback);
        }
        server = created;
        return created;
    }

    private Server ServeHostOrUdp(string hostOrUdp, Action? callback)
    {
        if (string.IsNullOrEmpty(hostOrUdp))
        {
            return ServeNetwork(null, null, null, callback);
        }
        return IsUdpType(hostOrUdp)
            ? ServeNetwork(null, null, hostOrUdp, callback)
            : ServeNetwork(hostOrUdp, null, null, callback);
    }

    private Server ServeNetwork(string? host, int? networkPort, string? udpType, Action? callback)
    {
        if (string.IsNullOrEmpty(host))
        {
            host = config.networkHost;
        }
        if (networkPort is null or 0)
        {
            networkPort = config.networkPort;
        }
        if (string.IsNullOrEmpty(udpType))
        {
            udpType = null;
        }
        if (udpType is not null && !IsUdpType(udpType))
        {
            throw new ArgumentException("UDP type must be udp4 or udp6.", nameof(udpType));
        }

        if (string.Equals(udpType, "udp4", StringComparison.OrdinalIgnoreCase) && host == "::1")
        {
            host = "127.0.0.1";
        }

        var created = new Server(host, config, LogArguments, networkPort);
        if (string.Equals(udpType, "udp4", StringComparison.OrdinalIgnoreCase))
        {
            created.udp4 = true;
        }
        else if (string.Equals(udpType, "udp6", StringComparison.OrdinalIgnoreCase))
        {
            created.udp6 = true;
        }
        if (callback is not null)
        {
            created.on("start", callback);
        }
        server = created;
        return created;
    }

    private void LogArguments(object?[] arguments) => log(arguments);

    private static bool IsUdpType(string value) =>
        value.Equals("udp4", StringComparison.OrdinalIgnoreCase) ||
        value.Equals("udp6", StringComparison.OrdinalIgnoreCase);

    private bool ValidateId(string id)
    {
        if (string.IsNullOrEmpty(id))
        {
            log(
                "Service id required",
                "Requested service connection without specifying service id. Aborting connection attempt");
            return false;
        }
        return true;
    }

    private static string FormatLogValue(object? value)
    {
        return value switch
        {
            null => "null",
            string text => text,
            Exception error => error.ToString(),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => TrySerialize(value)
        };
    }

    private static string TrySerialize(object value)
    {
        try
        {
            return JsonSerializer.Serialize(value);
        }
        catch (NotSupportedException)
        {
            return value.ToString() ?? string.Empty;
        }
    }
}

public sealed class IPCModule : IPC
{
    public Type IPC => typeof(IPC);
}

public static class NodeIPC
{
    public static IPCModule ipc => IPC.Default;
}
