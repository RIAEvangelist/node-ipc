using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace NodeIpc;

public class IPCProtocolException : IOException
{
    public IPCProtocolException(string code, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
    public string code => Code;
}

/// <summary>JavaScript export-name alias for <see cref="IPCProtocolException"/>.</summary>
public sealed class IPCProtocolError : IPCProtocolException
{
    public IPCProtocolError(string code, string message, Exception? innerException = null)
        : base(code, message, innerException)
    {
    }
}

public static class IPCProtocolCodes
{
    public const string InvalidJson = "ERR_IPC_INVALID_JSON";
    public const string InvalidMessage = "ERR_IPC_INVALID_MESSAGE";
    public const string InvalidEvent = "ERR_IPC_INVALID_EVENT";
    public const string EventTooLarge = "ERR_IPC_EVENT_TOO_LARGE";
    public const string ReservedEvent = "ERR_IPC_RESERVED_EVENT";
    public const string EventNotAllowed = "ERR_IPC_EVENT_NOT_ALLOWED";
    public const string FrameTooLarge = "ERR_IPC_FRAME_TOO_LARGE";
    public const string Backpressure = "ERR_IPC_BACKPRESSURE";
    public const string MessageTimeout = "ERR_IPC_MESSAGE_TIMEOUT";
    public const string AssuredTransport = "ERR_IPC_ASSURED_TRANSPORT";
    public const string AssuredTls = "ERR_IPC_ASSURED_TLS";
    public const string TlsConfiguration = "ERR_IPC_TLS_CONFIGURATION";
    public const string SocketRoot = "ERR_IPC_SOCKET_ROOT";
    public const string UnlinkNotSocket = "ERR_IPC_UNLINK_NOT_SOCKET";
}

public sealed class IpcMessage
{
    public IpcMessage(string type, JsonElement? data, bool hasData = true)
    {
        this.type = type;
        this.data = data;
        this.hasData = hasData;
    }

    public string type { get; }
    public JsonElement? data { get; }
    public bool hasData { get; }

    public T? getData<T>(JsonSerializerOptions? options = null)
    {
        if (!hasData || data is null)
        {
            return default;
        }

        return data.Value.Deserialize<T>(options);
    }

    internal object? DispatchData => hasData && data is not null ? data.Value : null;
}

/// <summary>The completed frames and retained tail returned by <see cref="Parser.push"/>.</summary>
public sealed class ParserPushResult
{
    internal ParserPushResult(IReadOnlyList<string> events, string remainder)
    {
        this.events = events;
        this.remainder = remainder;
    }

    public IReadOnlyList<string> events { get; }
    public string remainder { get; }
}

public interface IParser
{
    string profile => "custom";
    bool raw => false;
    Encoding wireEncoding => new UTF8Encoding(false, false);
    long? maxPendingBytes => null;
    int messageTimeout => 0;
    byte[] delimiterBytes => [];

    byte[] encode(string type) => encode(type, null);
    byte[] encode(string type, object? data);
    void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive);
    IpcMessage decode(ReadOnlySpan<byte> frame) => throw new NotSupportedException(
        "This custom parser decodes through read() only.");
}

public sealed class FrameBuffer
{
    private byte[] _bytes = Array.Empty<byte>();

    public int length { get; private set; }
    public ReadOnlySpan<byte> span => _bytes.AsSpan(0, length);

    public void append(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty)
        {
            return;
        }

        EnsureCapacity(checked(length + data.Length));
        data.CopyTo(_bytes.AsSpan(length));
        length += data.Length;
    }

    public List<byte[]> extract(ReadOnlySpan<byte> delimiter)
    {
        if (delimiter.IsEmpty)
        {
            throw new ArgumentException("delimiter must not be empty", nameof(delimiter));
        }

        var frames = new List<byte[]>();
        var consumed = 0;
        while (consumed <= length - delimiter.Length)
        {
            var relative = _bytes.AsSpan(consumed, length - consumed).IndexOf(delimiter);
            if (relative < 0)
            {
                break;
            }

            var boundary = consumed + relative;
            frames.Add(_bytes.AsSpan(consumed, boundary - consumed).ToArray());
            consumed = boundary + delimiter.Length;
        }

        if (consumed > 0)
        {
            var remaining = length - consumed;
            if (remaining > 0)
            {
                Buffer.BlockCopy(_bytes, consumed, _bytes, 0, remaining);
            }

            length = remaining;
        }

        return frames;
    }

    public void clear() => length = 0;

    internal void release()
    {
        _bytes = Array.Empty<byte>();
        length = 0;
    }

    private void EnsureCapacity(int required)
    {
        if (_bytes.Length >= required)
        {
            return;
        }

        var capacity = _bytes.Length == 0 ? 256 : _bytes.Length;
        while (capacity < required)
        {
            capacity = checked(capacity * 2);
        }

        Array.Resize(ref _bytes, capacity);
    }
}

public class RawParser : IParser
{
    public RawParser(Defaults? config = null)
    {
        wireEncoding = (config ?? new Defaults()).TextEncoding;
    }

    public string profile => "raw";
    public bool raw => true;
    public Encoding wireEncoding { get; }
    public long? maxPendingBytes => null;
    public int messageTimeout => 0;
    public byte[] delimiterBytes => [];

    public byte[] encode(string type) => wireEncoding.GetBytes(type);
    public byte[] encode(string type, object? data) => encode(type);
    public byte[] encode(ReadOnlySpan<byte> data) => data.ToArray();
    public byte[] format(string value) => encode(value);
    public byte[] format(ReadOnlySpan<byte> value) => encode(value);
    public IReadOnlyList<byte[]> parse(ReadOnlySpan<byte> data) => [data.ToArray()];

    public void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive) =>
        throw new NotSupportedException("RawParser delivers transport bytes through the data event.");

    public IpcMessage decode(ReadOnlySpan<byte> frame) =>
        throw new NotSupportedException("RawParser does not decode event envelopes.");
}

public class Parser : IParser
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNamingPolicy = null,
        WriteIndented = false
    };

    public Parser(Defaults? config = null)
    {
        var selected = config ?? new Defaults();
        if (string.IsNullOrEmpty(selected.delimiter))
        {
            throw new ArgumentException("ipc.config.delimiter must be a non-empty string", nameof(config));
        }

        delimiter = selected.delimiter;
        delimiterBytes = Encoding.UTF8.GetBytes(delimiter);
    }

    public virtual string profile => "fast";
    public bool raw => false;
    public Encoding wireEncoding { get; } = new UTF8Encoding(false, false);
    public virtual long? maxPendingBytes => null;
    public virtual int messageTimeout => 0;
    public string delimiter { get; }
    public byte[] delimiterBytes { get; }

    public virtual byte[] encode(string type) => EncodeEnvelope(type, EmptyPayload.Value);

    public virtual byte[] encode(string type, object? data) => EncodeEnvelope(type, data);

    public virtual byte[] format(IpcMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return message.hasData ? encode(message.type, message.data) : encode(message.type);
    }

    public virtual ParserPushResult push(string buffer = "", string data = "")
    {
        var combined = string.IsNullOrEmpty(buffer) ? data : buffer + data;
        var events = new List<string>();
        var start = 0;
        var end = combined.IndexOf(delimiter, StringComparison.Ordinal);
        while (end >= 0)
        {
            events.Add(combined[start..end]);
            start = end + delimiter.Length;
            end = combined.IndexOf(delimiter, start, StringComparison.Ordinal);
        }

        return new ParserPushResult(events, start == 0 ? combined : combined[start..]);
    }

    public virtual IReadOnlyList<string> parse(string data) => push(string.Empty, data).events;

    public virtual void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive)
    {
        ArgumentNullException.ThrowIfNull(receive);
        buffer.append(data);
        var frames = buffer.extract(delimiterBytes);
        foreach (var frame in frames)
        {
            receive(decode(frame));
        }
    }

    public virtual IpcMessage decode(ReadOnlySpan<byte> frame)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(frame.ToArray());
        }
        catch (JsonException error)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.InvalidJson,
                "received message is not valid JSON",
                error);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("type", out var typeElement) ||
                typeElement.ValueKind != JsonValueKind.String)
            {
                throw InvalidFastEnvelope();
            }

            var type = typeElement.GetString();
            if (type is null)
            {
                throw InvalidFastEnvelope();
            }

            var hasData = root.TryGetProperty("data", out var dataElement);
            return new IpcMessage(type, hasData ? dataElement.Clone() : null, hasData);
        }
    }

    protected byte[] EncodeEnvelope(string type, object? data)
    {
        var writerBuffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(writerBuffer, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            Indented = false,
            SkipValidation = false
        }))
        {
            writer.WriteStartObject();
            writer.WriteString("type", type);
            writer.WritePropertyName("data");
            if (ReferenceEquals(data, EmptyPayload.Value))
            {
                writer.WriteStartObject();
                writer.WriteEndObject();
            }
            else if (data is JsonElement element)
            {
                element.WriteTo(writer);
            }
            else
            {
                JsonSerializer.Serialize(writer, data, data?.GetType() ?? typeof(object), SerializerOptions);
            }

            writer.WriteEndObject();
        }

        var frame = new byte[writerBuffer.WrittenCount + delimiterBytes.Length];
        writerBuffer.WrittenSpan.CopyTo(frame);
        delimiterBytes.CopyTo(frame, writerBuffer.WrittenCount);
        return frame;
    }

    private static IPCProtocolException InvalidFastEnvelope() => new(
        IPCProtocolCodes.InvalidMessage,
        "Fast messages must expose a string type before C# event dispatch.");

    private sealed class EmptyPayload
    {
        public static readonly EmptyPayload Value = new();
    }
}

public sealed class FastParser : Parser
{
    public FastParser(Defaults? config = null) : base(config)
    {
    }
}

public class GuardedParser : Parser
{
    private static readonly HashSet<string> ReservedEventTypes = new(StringComparer.Ordinal)
    {
        "start", "connect", "disconnect", "destroy", "close", "socket.disconnected", "error", "data"
    };

    private static readonly HashSet<string> UnsafeEventTypes = new(StringComparer.Ordinal)
    {
        "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
        "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable",
        "toString", "valueOf", "__proto__", "toLocaleString"
    };

    protected readonly long MaximumMessageSize;
    protected readonly int MaximumEventNameLength;
    protected bool AllowReservedEvents;

    public GuardedParser(Defaults? config = null) : base(config)
    {
        var selected = config ?? new Defaults();
        ValidatePositive(selected.maxMessageSize, nameof(selected.maxMessageSize));
        ValidatePositive(selected.maxPendingBytes, nameof(selected.maxPendingBytes));
        ValidatePositive(selected.maxEventNameLength, nameof(selected.maxEventNameLength));
        if (selected.messageTimeout < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(config), "ipc.config.messageTimeout must be zero or a positive integer");
        }

        MaximumMessageSize = selected.maxMessageSize;
        maxPendingBytes = selected.maxPendingBytes;
        MaximumEventNameLength = selected.maxEventNameLength;
        messageTimeout = selected.messageTimeout;
        AllowReservedEvents = selected.allowReservedEvents;
    }

    public override string profile => "guarded";
    public override long? maxPendingBytes { get; }
    public override int messageTimeout { get; }

    public override byte[] encode(string type)
    {
        ValidateType(type);
        var frame = base.encode(type);
        AssertFrameSize(frame.Length - delimiterBytes.Length);
        return frame;
    }

    public override byte[] encode(string type, object? data)
    {
        ValidateType(type);
        var frame = base.encode(type, data);
        AssertFrameSize(frame.Length - delimiterBytes.Length);
        return frame;
    }

    public override void read(FrameBuffer buffer, ReadOnlySpan<byte> data, Action<IpcMessage> receive)
    {
        ArgumentNullException.ThrowIfNull(receive);
        buffer.append(data);
        var frames = buffer.extract(delimiterBytes);
        foreach (var frame in frames)
        {
            AssertFrameSize(frame.Length);
            receive(decode(frame));
        }

        AssertFrameSize(buffer.length);
    }

    public override IpcMessage decode(ReadOnlySpan<byte> frame)
    {
        AssertFrameSize(frame.Length);
        IpcMessage message;
        try
        {
            message = base.decode(frame);
        }
        catch (InvalidDataException error)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.InvalidMessage,
                "received message must be a JSON object with a string type",
                error);
        }

        ValidateType(message.type);
        return message;
    }

    public override ParserPushResult push(string buffer = "", string data = "")
    {
        var parsed = base.push(buffer, data);
        foreach (var frame in parsed.events)
        {
            AssertFrameSize(wireEncoding.GetByteCount(frame));
        }
        AssertFrameSize(wireEncoding.GetByteCount(parsed.remainder));
        return parsed;
    }

    protected virtual void ValidateType(string type)
    {
        if (string.IsNullOrEmpty(type))
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.InvalidEvent,
                "event type must be a non-empty string");
        }

        if (type.Length > MaximumEventNameLength)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.EventTooLarge,
                "event type exceeds maxEventNameLength");
        }

        if (UnsafeEventTypes.Contains(type))
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.InvalidEvent,
                $"event type \"{type}\" is not safe for the active event dispatcher");
        }

        if (!AllowReservedEvents && ReservedEventTypes.Contains(type))
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.ReservedEvent,
                $"event type \"{type}\" is reserved for local lifecycle events");
        }
    }

    protected void AssertFrameSize(long bytes)
    {
        if (bytes <= MaximumMessageSize)
        {
            return;
        }

        throw new IPCProtocolException(
            IPCProtocolCodes.FrameTooLarge,
            "message exceeds maxMessageSize");
    }

    private static void ValidatePositive(long value, string name)
    {
        if (value < 1)
        {
            throw new ArgumentOutOfRangeException(name, $"ipc.config.{name} must be a positive integer");
        }
    }
}

/// <summary>Compatibility parser matching the JavaScript node-ipc/parsers/message export.</summary>
public sealed class MessageParser : Parser
{
    public MessageParser(Defaults? config = null) : base(config)
    {
    }

    public override IpcMessage decode(ReadOnlySpan<byte> frame)
    {
        try
        {
            return base.decode(frame);
        }
        catch (IPCProtocolException error) when (error.Code == IPCProtocolCodes.InvalidJson)
        {
            var response = wireEncoding.GetString(frame);
            var data = JsonSerializer.SerializeToElement(new
            {
                message = "Invalid JSON response format",
                err = new { name = error.GetType().Name, message = error.Message },
                response
            });
            return new IpcMessage("error", data);
        }
    }
}

public sealed class AssuredParser : GuardedParser
{
    private readonly HashSet<string> _allowedEvents;

    public AssuredParser(Defaults? config = null) : base(config)
    {
        var selected = config ?? new Defaults();
        if (selected.allowedEvents is null || selected.allowedEvents.Count == 0)
        {
            throw new ArgumentException(
                "ipc.config.allowedEvents must be a non-empty set for the assured parser",
                nameof(config));
        }

        _allowedEvents = new HashSet<string>(selected.allowedEvents, StringComparer.Ordinal);
        AllowReservedEvents = false;
    }

    public override string profile => "assured";

    protected override void ValidateType(string type)
    {
        base.ValidateType(type);
        if (!_allowedEvents.Contains(type))
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.EventNotAllowed,
                "event type is not in allowedEvents");
        }
    }
}

public static class ParserFactory
{
    public static IParser create(Defaults config)
    {
        ArgumentNullException.ThrowIfNull(config);
        if (config.rawBuffer)
        {
            return new RawParser(config);
        }

        if (config.parserInstance is not null)
        {
            return config.parserInstance;
        }

        if (config.parserFactory is not null)
        {
            return config.parserFactory(config) ?? throw new InvalidOperationException(
                "ipc.config.parserFactory returned null");
        }

        return config.parser.ToLowerInvariant() switch
        {
            "raw" => new RawParser(config),
            "" or "fast" => new FastParser(config),
            "guarded" => new GuardedParser(config),
            "assured" => new AssuredParser(config),
            _ => throw new ArgumentException(
                "ipc.config.parser must be raw, fast, guarded, assured, or a custom parser",
                nameof(config))
        };
    }
}
