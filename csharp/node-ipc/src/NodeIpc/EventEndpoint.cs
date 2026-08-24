using System.Collections.ObjectModel;
using System.Text.Json;

namespace NodeIpc;

/// <summary>Synchronous, registration-ordered event subscriptions shared by clients and servers.</summary>
public abstract class EventEndpoint
{
    private readonly EventRegistry _events = new();

    public IReadOnlyDictionary<string, IReadOnlyList<Delegate>> list => _events.Snapshot();

    public EventEndpoint on(string type, Action handler) => Register(type, handler, false, _ => handler());

    public EventEndpoint on(string type, Action<object?> handler) =>
        Register(type, handler, false, arguments => handler(Argument(arguments, 0)));

    public EventEndpoint on(string type, Action<object?[]> handler) =>
        Register(type, handler, false, handler);

    public EventEndpoint on<T>(string type, Action<T> handler) =>
        Register(type, handler, false, arguments => handler(ConvertArgument<T>(Argument(arguments, 0))));

    public EventEndpoint on<TFirst, TSecond>(string type, Action<TFirst, TSecond> handler) =>
        Register(type, handler, false, arguments => handler(
            ConvertArgument<TFirst>(Argument(arguments, 0)),
            ConvertArgument<TSecond>(Argument(arguments, 1))));

    public EventEndpoint once(string type, Action handler) => Register(type, handler, true, _ => handler());

    public EventEndpoint once(string type, Action<object?> handler) =>
        Register(type, handler, true, arguments => handler(Argument(arguments, 0)));

    public EventEndpoint once(string type, Action<object?[]> handler) =>
        Register(type, handler, true, handler);

    public EventEndpoint once<T>(string type, Action<T> handler) =>
        Register(type, handler, true, arguments => handler(ConvertArgument<T>(Argument(arguments, 0))));

    public EventEndpoint once<TFirst, TSecond>(string type, Action<TFirst, TSecond> handler) =>
        Register(type, handler, true, arguments => handler(
            ConvertArgument<TFirst>(Argument(arguments, 0)),
            ConvertArgument<TSecond>(Argument(arguments, 1))));

    public EventEndpoint off(string type = "*", Delegate? handler = null)
    {
        _events.Off(type, handler);
        return this;
    }

    public EventEndpoint reset()
    {
        _events.Reset();
        return this;
    }

    protected void Publish(string type, params object?[] arguments) => _events.Publish(type, arguments);

    protected static T ConvertArgument<T>(object? value)
    {
        if (value is T typed)
        {
            return typed;
        }

        if (value is JsonElement json)
        {
            var deserialized = json.Deserialize<T>();
            if (deserialized is not null || default(T) is null)
            {
                return deserialized!;
            }
        }

        if (value is null && default(T) is null)
        {
            return default!;
        }

        throw new InvalidCastException(
            $"Cannot deliver event argument of type {value?.GetType().FullName ?? "null"} as {typeof(T).FullName}.");
    }

    private EventEndpoint Register(string type, Delegate original, bool once, Action<object?[]> invoker)
    {
        _events.On(type, original, once, invoker);
        return this;
    }

    private static object? Argument(object?[] arguments, int index) =>
        index < arguments.Length ? arguments[index] : null;

    private sealed class EventRegistry
    {
        private readonly object _gate = new();
        private Dictionary<string, List<Registration>> _registrations = new(StringComparer.Ordinal);

        public void On(string type, Delegate original, bool once, Action<object?[]> invoker)
        {
            ArgumentNullException.ThrowIfNull(type);
            ArgumentNullException.ThrowIfNull(original);
            lock (_gate)
            {
                if (!_registrations.TryGetValue(type, out var bucket))
                {
                    bucket = [];
                    _registrations[type] = bucket;
                }

                bucket.Add(new Registration(original, once, invoker));
            }
        }

        public void Off(string type, Delegate? handler)
        {
            ArgumentNullException.ThrowIfNull(type);
            lock (_gate)
            {
                if (!_registrations.TryGetValue(type, out var bucket))
                {
                    return;
                }

                if (handler is null)
                {
                    _registrations.Remove(type);
                    return;
                }

                bucket.RemoveAll(registration => registration.Original == handler);
                if (bucket.Count == 0 &&
                    _registrations.TryGetValue(type, out var current) &&
                    ReferenceEquals(current, bucket))
                {
                    _registrations.Remove(type);
                }
            }
        }

        public void Reset()
        {
            lock (_gate)
            {
                _registrations = new Dictionary<string, List<Registration>>(StringComparer.Ordinal);
            }
        }

        public IReadOnlyDictionary<string, IReadOnlyList<Delegate>> Snapshot()
        {
            lock (_gate)
            {
                var snapshot = new Dictionary<string, IReadOnlyList<Delegate>>(StringComparer.Ordinal);
                foreach (var (type, registrations) in _registrations)
                {
                    snapshot[type] = Array.AsReadOnly(registrations.Select(entry => entry.Original).ToArray());
                }

                return new ReadOnlyDictionary<string, IReadOnlyList<Delegate>>(snapshot);
            }
        }

        public void Publish(string type, object?[] arguments)
        {
            ArgumentNullException.ThrowIfNull(type);
            Dispatch("*", Prepend(type, arguments));
            if (type != "*")
            {
                Dispatch(type, arguments);
            }
        }

        private void Dispatch(string type, object?[] arguments)
        {
            List<Registration>? bucket;
            lock (_gate)
            {
                _registrations.TryGetValue(type, out bucket);
            }

            if (bucket is null)
            {
                return;
            }

            var index = 0;
            while (true)
            {
                Registration registration;
                lock (_gate)
                {
                    if (index >= bucket.Count)
                    {
                        break;
                    }

                    registration = bucket[index];
                    if (registration.Once)
                    {
                        bucket.RemoveAt(index);
                    }
                    else
                    {
                        index++;
                    }
                }

                registration.Invoker(arguments);
            }

            lock (_gate)
            {
                if (bucket.Count == 0 &&
                    _registrations.TryGetValue(type, out var current) &&
                    ReferenceEquals(current, bucket))
                {
                    _registrations.Remove(type);
                }
            }
        }

        private static object?[] Prepend(string type, object?[] arguments)
        {
            var wildcardArguments = new object?[arguments.Length + 1];
            wildcardArguments[0] = type;
            arguments.CopyTo(wildcardArguments, 1);
            return wildcardArguments;
        }

        private sealed record Registration(Delegate Original, bool Once, Action<object?[]> Invoker);
    }
}
