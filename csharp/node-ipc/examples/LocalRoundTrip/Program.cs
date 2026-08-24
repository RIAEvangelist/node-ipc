using System.Text.Json;
using NodeIpc;

var name = "node-ipc-csharp-example-" + Environment.ProcessId;
var root = OperatingSystem.IsWindows() ? string.Empty : Path.Combine(Path.GetTempPath(), name);
var endpoint = OperatingSystem.IsWindows() ? "/" + name : Path.Combine(root, "example.sock");
try
{
    await using var serverIpc = Configured(root);
    var server = serverIpc.serve(endpoint);
    server.on<JsonElement>("example.request", (data, peer) =>
        server.emit(peer, "example.response", data));
    server.start();

    await using var clientIpc = Configured(root);
    var client = clientIpc.connectTo("example", endpoint)!;
    var response = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
    client.on<JsonElement>("example.response", data => response.TrySetResult(data));
    await client.waitForConnectAsync();
    await client.emitAsync("example.request", new { transport = OperatingSystem.IsWindows() ? "pipe" : "unix" });
    Console.WriteLine((await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("transport").GetString());
}
finally
{
    if (!OperatingSystem.IsWindows() && Directory.Exists(root))
    {
        Directory.Delete(root, recursive: true);
    }
}

static IPCModule Configured(string root)
{
    var ipc = new IPCModule();
    ipc.config.silent = true;
    ipc.config.stopRetrying = true;
    ipc.config.maxRetries = 0;
    if (!OperatingSystem.IsWindows())
    {
        ipc.config.socketRoot = root + Path.DirectorySeparatorChar;
    }
    return ipc;
}
