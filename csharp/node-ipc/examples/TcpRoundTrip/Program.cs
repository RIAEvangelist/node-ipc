using System.Text.Json;
using NodeIpc;

const int port = 9763;
await using var serverIpc = Configured(port);
var server = serverIpc.serveNet("127.0.0.1", port);
server.on<JsonElement>("example.request", (data, peer) =>
    server.emit(peer, "example.response", data));
server.start();

await using var clientIpc = Configured(port);
var client = clientIpc.connectToNet("example", "127.0.0.1", port)!;
var response = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
client.on<JsonElement>("example.response", data => response.TrySetResult(data));
await client.waitForConnectAsync();
await client.emitAsync("example.request", new { message = "hello from C#" });
Console.WriteLine((await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("message").GetString());

static IPCModule Configured(int port)
{
    var ipc = new IPCModule();
    ipc.config.silent = true;
    ipc.config.networkPort = port;
    ipc.config.stopRetrying = true;
    ipc.config.maxRetries = 0;
    return ipc;
}
