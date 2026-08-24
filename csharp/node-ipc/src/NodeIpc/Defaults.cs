using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace NodeIpc;

/// <summary>Mutable configuration captured by each new client or server.</summary>
public sealed class Defaults
{
    public string appspace { get; set; } = "app.";
    public string socketRoot { get; set; } = GetSocketRoot();
    public string id { get; set; } = Dns.GetHostName();

    public string encoding { get; set; } = "utf8";
    public bool rawBuffer { get; set; }
    public string parser { get; set; } = "fast";
    public Func<Defaults, IParser>? parserFactory { get; set; }
    public IParser? parserInstance { get; set; }
    public bool sync { get; set; }
    public bool unlink { get; set; } = true;
    public bool identifyPeer { get; set; }

    public string delimiter { get; set; } = "\f";
    public long maxMessageSize { get; set; } = 1024 * 1024;
    public long maxPendingBytes { get; set; } = 8 * 1024 * 1024;
    public int maxEventNameLength { get; set; } = 256;
    public int messageTimeout { get; set; } = 30_000;
    public bool allowReservedEvents { get; set; }
    public ISet<string>? allowedEvents { get; set; }

    public bool silent { get; set; }
    public bool logPayloads { get; set; }
    public int logDepth { get; set; } = 5;
    public bool logInColor { get; set; } = true;
    public Action<string> logger { get; set; } = Console.WriteLine;

    public int maxConnections { get; set; } = 100;
    public int retry { get; set; } = 500;
    public long maxRetries { get; set; } = long.MaxValue;
    public bool stopRetrying { get; set; }

    public string IPType { get; set; } = GetIPType();
    public string networkHost
    {
        get => _networkHost ??= IPType == "IPv6" ? "::1" : "127.0.0.1";
        set => _networkHost = value;
    }
    public int networkPort { get; set; } = 8000;
    public TlsOptions? tls { get; set; }

    public bool readableAll { get; set; }
    public bool writableAll { get; set; }
    public bool secureSocketRoot { get; set; } = true;
    public InterfaceOptions @interface { get; set; } = new();

    private string? _networkHost;

    internal Encoding TextEncoding
    {
        get
        {
            if (encoding.Equals("utf8", StringComparison.OrdinalIgnoreCase) ||
                encoding.Equals("utf-8", StringComparison.OrdinalIgnoreCase))
            {
                return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false);
            }

            return Encoding.GetEncoding(encoding);
        }
    }

    private static string GetSocketRoot()
    {
        var user = SafePathSegment(Environment.UserName);
        if (OperatingSystem.IsWindows())
        {
            return $"/node-ipc-{user}/";
        }

        var runtimeRoot = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        if (!string.IsNullOrWhiteSpace(runtimeRoot))
        {
            return Path.Combine(runtimeRoot, "node-ipc") + Path.DirectorySeparatorChar;
        }

        var userId = UnixIdentity.TryGetEffectiveUserId(out var uid) ? uid.ToString() : user;
        return Path.Combine(Path.GetTempPath(), $"node-ipc-{userId}") + Path.DirectorySeparatorChar;
    }

    private static string GetIPType()
    {
        try
        {
            foreach (var networkInterface in NetworkInterface.GetAllNetworkInterfaces())
            {
                var address = networkInterface.GetIPProperties().UnicastAddresses.FirstOrDefault()?.Address;
                if (address is not null)
                {
                    return address.AddressFamily == AddressFamily.InterNetworkV6 ? "IPv6" : "IPv4";
                }
            }
        }
        catch (NetworkInformationException)
        {
            // Match the JavaScript default's best-effort interface detection.
        }

        return string.Empty;
    }

    private static string SafePathSegment(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '-'
                ? character
                : '_');
        }

        return builder.ToString();
    }
}

public sealed class InterfaceOptions
{
    public IPAddress? localAddress { get; set; }
    public int? localPort { get; set; }
    public AddressFamily? family { get; set; }
}

public sealed class TlsOptions
{
    public X509Certificate2? certificate { get; set; }
    public X509Certificate2Collection trustedCertificates { get; } = [];
    public X509Certificate2Collection clientCertificates { get; } = [];
    public string? @private { get; set; }
    public string? @public { get; set; }
    public string? key { get; set; }
    public string? cert { get; set; }
    public IEnumerable<string>? trustedConnections { get; set; }
    public bool? rejectUnauthorized { get; set; }
    public bool? requestCert { get; set; }
    public string? targetHost { get; set; }
    public SslProtocols enabledSslProtocols { get; set; } = SslProtocols.None;
    public RemoteCertificateValidationCallback? remoteCertificateValidationCallback { get; set; }
    internal bool IdentityNormalized { get; set; }

    internal TlsOptions Snapshot()
    {
        var snapshot = new TlsOptions
        {
            certificate = certificate,
            @private = @private,
            @public = @public,
            key = key,
            cert = cert,
            trustedConnections = trustedConnections?.ToArray(),
            rejectUnauthorized = rejectUnauthorized,
            requestCert = requestCert,
            targetHost = targetHost,
            enabledSslProtocols = enabledSslProtocols,
            remoteCertificateValidationCallback = remoteCertificateValidationCallback,
            IdentityNormalized = IdentityNormalized
        };
        snapshot.trustedCertificates.AddRange(trustedCertificates);
        snapshot.clientCertificates.AddRange(clientCertificates);
        TransportSecurity.MaterializeTrustedCertificates(snapshot);
        TransportSecurity.MaterializeIdentityCertificate(snapshot);
        return snapshot;
    }
}
