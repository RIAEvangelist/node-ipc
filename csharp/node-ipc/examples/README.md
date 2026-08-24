# C# examples

Each example is a dependency-free .NET 8 console project using the JavaScript-shaped
`IPCModule` API.

```console
dotnet run --project csharp/node-ipc/examples/TcpRoundTrip
dotnet run --project csharp/node-ipc/examples/LocalRoundTrip
dotnet run --project csharp/node-ipc/examples/UdpRoundTrip
```

`TcpRoundTrip` demonstrates targeted request/response, `LocalRoundTrip` selects a Unix domain
socket or Windows named pipe through the same API, and `UdpRoundTrip` demonstrates learned UDP
peers. TLS and Assured configuration are documented in the package README because production
certificate material should not be embedded in an example project.
