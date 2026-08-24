using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace NodeIpc;

internal static class TransportSecurity
{
    public static void ValidateClientConfiguration(TlsOptions options, bool assured)
    {
        MaterializeTrustedCertificates(options);
        var certificate = LoadIdentityCertificate(options, required: false);
        if (!assured)
        {
            return;
        }

        if (options.remoteCertificateValidationCallback is not null)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.AssuredTls,
                "Assured TLS does not permit a callback that can replace mandatory certificate validation.");
        }

        if (certificate is null ||
            !certificate.HasPrivateKey ||
            options.trustedCertificates.Count == 0 ||
            options.rejectUnauthorized == false)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.AssuredTls,
                "Assured network clients require a key, certificate, trusted CA, and rejectUnauthorized=true.");
        }
    }

    public static void ValidateServerConfiguration(TlsOptions options, bool assured)
    {
        MaterializeTrustedCertificates(options);
        _ = LoadIdentityCertificate(options, required: true);
        var requestCertificate = options.requestCert ?? options.trustedCertificates.Count > 0;
        var rejectUnauthorized = options.rejectUnauthorized ?? requestCertificate;
        if (assured && (!requestCertificate || !rejectUnauthorized || options.trustedCertificates.Count == 0))
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.AssuredTls,
                "Assured network servers require a trusted client CA, requestCert=true, and rejectUnauthorized=true.");
        }
        if (assured && options.remoteCertificateValidationCallback is not null)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.AssuredTls,
                "Assured TLS does not permit a callback that can replace mandatory certificate validation.");
        }
    }

    public static async Task<SslStream> AuthenticateClientAsync(
        Stream transport,
        string host,
        TlsOptions options,
        CancellationToken cancellationToken)
    {
        MaterializeTrustedCertificates(options);
        var rejectUnauthorized = options.rejectUnauthorized ?? true;
        var validator = options.remoteCertificateValidationCallback ??
            ((_, certificate, chain, errors) => ValidateRemoteCertificate(
                certificate,
                chain,
                errors,
                options.trustedCertificates,
                rejectUnauthorized,
                "1.3.6.1.5.5.7.3.1"));
        var ssl = new SslStream(transport, leaveInnerStreamOpen: false, validator);
        var certificates = new X509CertificateCollection();
        var identity = LoadIdentityCertificate(options, required: false);
        if (identity is not null)
        {
            certificates.Add(identity);
        }
        foreach (var certificate in options.clientCertificates)
        {
            certificates.Add(certificate);
        }

        await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
        {
            TargetHost = options.targetHost ?? host,
            ClientCertificates = certificates,
            EnabledSslProtocols = options.enabledSslProtocols,
            CertificateChainPolicy = OfflineChainPolicy()
        }, cancellationToken).ConfigureAwait(false);
        return ssl;
    }

    public static async Task<SslStream> AuthenticateServerAsync(
        Stream transport,
        TlsOptions options,
        CancellationToken cancellationToken)
    {
        MaterializeTrustedCertificates(options);
        var identity = LoadIdentityCertificate(options, required: true)!;
        var requestCertificate = options.requestCert ?? options.trustedCertificates.Count > 0;
        var rejectUnauthorized = options.rejectUnauthorized ?? requestCertificate;
        var validator = options.remoteCertificateValidationCallback ??
            ((_, certificate, chain, errors) => !requestCertificate || ValidateRemoteCertificate(
                certificate,
                chain,
                errors,
                options.trustedCertificates,
                rejectUnauthorized,
                "1.3.6.1.5.5.7.3.2"));
        var ssl = new SslStream(transport, leaveInnerStreamOpen: false, validator);
        await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
        {
            ServerCertificate = identity,
            ClientCertificateRequired = requestCertificate,
            EnabledSslProtocols = options.enabledSslProtocols,
            CertificateChainPolicy = OfflineChainPolicy()
        }, cancellationToken).ConfigureAwait(false);
        return ssl;
    }

    private static X509Certificate2? LoadIdentityCertificate(TlsOptions options, bool required)
    {
        if (options.certificate is not null)
        {
            var identity = NormalizeIdentityCertificate(options);
            if (required && !identity.HasPrivateKey)
            {
                throw MissingPrivateKey();
            }
            return identity;
        }

        var certificateSource = options.cert ?? options.@public;
        var keySource = options.key ?? options.@private;
        if (!string.IsNullOrWhiteSpace(certificateSource) && !string.IsNullOrWhiteSpace(keySource))
        {
            options.certificate = File.Exists(certificateSource) && File.Exists(keySource)
                ? X509Certificate2.CreateFromPemFile(certificateSource, keySource)
                : X509Certificate2.CreateFromPem(certificateSource, keySource);
            var identity = NormalizeIdentityCertificate(options);
            if (!identity.HasPrivateKey)
            {
                throw MissingPrivateKey();
            }
            return identity;
        }

        if (required)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.TlsConfiguration,
                "TLS servers require an explicit key and certificate.");
        }

        return null;
    }

    private static IPCProtocolException MissingPrivateKey() => new(
        IPCProtocolCodes.TlsConfiguration,
        "TLS identities require a certificate with its private key.");

    private static X509Certificate2 NormalizeIdentityCertificate(TlsOptions options)
    {
        if (!OperatingSystem.IsWindows() || options.IdentityNormalized || options.certificate is null)
        {
            return options.certificate!;
        }

        if (options.certificate.HasPrivateKey)
        {
            var pfx = options.certificate.Export(X509ContentType.Pfx);
            options.certificate = new X509Certificate2(
                pfx,
                (string?)null,
                X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.Exportable);
        }
        options.IdentityNormalized = true;
        return options.certificate;
    }

    internal static void MaterializeTrustedCertificates(TlsOptions options)
    {
        if (options.trustedConnections is null)
        {
            return;
        }

        foreach (var source in options.trustedConnections)
        {
            var loaded = LoadCertificates(source);
            try
            {
                foreach (var certificate in loaded.Cast<X509Certificate2>())
                {
                    if (options.trustedCertificates.Cast<X509Certificate2>().Any(existing =>
                            string.Equals(
                                existing.Thumbprint,
                                certificate.Thumbprint,
                                StringComparison.OrdinalIgnoreCase)))
                    {
                        continue;
                    }

                    options.trustedCertificates.Add(new X509Certificate2(certificate));
                }
            }
            finally
            {
                foreach (var certificate in loaded.Cast<X509Certificate2>())
                {
                    certificate.Dispose();
                }
            }
        }

        // Trust inputs are captured once, just like Node's TLS options. A file changed
        // after client/server construction must not silently alter the trust boundary.
        options.trustedConnections = null;
    }

    internal static void MaterializeIdentityCertificate(TlsOptions options) =>
        _ = LoadIdentityCertificate(options, required: false);

    private static X509Certificate2Collection LoadCertificates(string source)
    {
        var certificates = new X509Certificate2Collection();
        try
        {
            if (File.Exists(source))
            {
                certificates.ImportFromPemFile(source);
            }
            else
            {
                certificates.ImportFromPem(source);
            }
            return certificates;
        }
        catch
        {
            foreach (var certificate in certificates.Cast<X509Certificate2>())
            {
                certificate.Dispose();
            }
            throw;
        }
    }

    private static bool ValidateRemoteCertificate(
        X509Certificate? certificate,
        X509Chain? suppliedChain,
        SslPolicyErrors errors,
        X509Certificate2Collection trusted,
        bool rejectUnauthorized,
        string requiredEnhancedKeyUsage)
    {
        if (!rejectUnauthorized)
        {
            return true;
        }

        if (certificate is null)
        {
            return false;
        }

        if (trusted.Count == 0)
        {
            return errors == SslPolicyErrors.None;
        }

        if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch |
                       SslPolicyErrors.RemoteCertificateNotAvailable)) != 0)
        {
            return false;
        }

        using var remote = new X509Certificate2(certificate);
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true;
        chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
        chain.ChainPolicy.CustomTrustStore.AddRange(trusted);
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid(requiredEnhancedKeyUsage));
        if (suppliedChain is not null)
        {
            foreach (var element in suppliedChain.ChainElements.Cast<X509ChainElement>().Skip(1))
            {
                chain.ChainPolicy.ExtraStore.Add(element.Certificate);
            }
        }

        return chain.Build(remote);
    }

    private static X509ChainPolicy OfflineChainPolicy() => new()
    {
        RevocationMode = X509RevocationMode.NoCheck,
        DisableCertificateDownloads = true
    };
}
