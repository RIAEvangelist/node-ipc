using System.Text.Json;
using NodeIpc;

const int firstPort = 9764;
const int secondPort = 9765;
await using var firstIpc = Configured();
await using var secondIpc = Configured();
var first = firstIpc.serveNet("127.0.0.1", firstPort, "udp4");
var second = secondIpc.serveNet("127.0.0.1", secondPort, "udp4");
var response = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
first.on<JsonElement>("example.request", (data, peer) => first.emit(peer, "example.response", data));
second.on<JsonElement>("example.response", (data, _) => response.TrySetResult(data));
first.start();
second.start();
second.emit(second.peer("127.0.0.1", firstPort), "example.request", new { transport = "udp4" });
Console.WriteLine((await response.Task.WaitAsync(TimeSpan.FromSeconds(5))).GetProperty("transport").GetString());

static IPCModule Configured()
{
    var ipc = new IPCModule();
    ipc.config.silent = true;
    return ipc;
}
