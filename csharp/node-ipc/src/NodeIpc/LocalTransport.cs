using System.ComponentModel;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace NodeIpc;

internal static class LocalTransport
{
    public static string PipePath(string logicalPath)
    {
        if (logicalPath.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase))
        {
            return logicalPath;
        }

        var path = logicalPath.StartsWith("/", StringComparison.Ordinal)
            ? logicalPath[1..]
            : logicalPath;
        return @"\\.\pipe\" + path.Replace('/', '-').Replace('\\', '-');
    }

    public static string PipeName(string logicalPath)
    {
        var path = PipePath(logicalPath);
        return path[@"\\.\pipe\".Length..];
    }

    public static bool EndpointDirectlyInsideRoot(string endpoint, string socketRoot)
    {
        var root = Path.GetFullPath(socketRoot);
        var relative = Path.GetRelativePath(root, Path.GetFullPath(endpoint));
        return relative.Length > 0 &&
               relative != ".." &&
               !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
               !Path.IsPathRooted(relative) &&
               Path.GetDirectoryName(relative) is "" or null;
    }

    public static void PrepareSocketRoot(string endpoint, Defaults config)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = Path.GetFullPath(config.socketRoot);
        const UnixFileMode privateMode =
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        var relative = Path.GetRelativePath(root, Path.GetFullPath(endpoint));
        if (relative == ".." ||
            relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            Path.IsPathRooted(relative))
        {
            return;
        }

        var existed = UnixFileSystem.TryStat(root, out var originalStatus);
        if (existed && originalStatus.Type != UnixFileType.Directory)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.SocketRoot,
                "socketRoot must be a real directory");
        }

        if (existed || !config.secureSocketRoot)
        {
            Directory.CreateDirectory(root);
        }
        else
        {
            Directory.CreateDirectory(root, privateMode);
        }
        if (!config.secureSocketRoot)
        {
            return;
        }

        var status = UnixFileSystem.Stat(root);
        if (status.Type != UnixFileType.Directory)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.SocketRoot,
                "socketRoot must be a real directory");
        }

        if (UnixIdentity.TryGetEffectiveUserId(out var userId) && status.UserId != userId)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.SocketRoot,
                "socketRoot must be owned by the current user");
        }

        var mode = File.GetUnixFileMode(root);
        if ((mode & ~privateMode) != 0 || (mode & privateMode) != privateMode)
        {
            if (existed)
            {
                throw new IPCProtocolException(
                    IPCProtocolCodes.SocketRoot,
                    "an existing secure socketRoot must already have mode 0700; refusing to change an unrelated directory");
            }
            File.SetUnixFileMode(root, privateMode);
        }
    }

    public static void RemoveStaleSocket(string endpoint)
    {
        if (!UnixFileSystem.TryStat(endpoint, out var status))
        {
            return;
        }

        if (status.Type != UnixFileType.Socket)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.UnlinkNotSocket,
                "refusing to unlink a non-socket path");
        }

        var confirmed = UnixFileSystem.Stat(endpoint);
        if (confirmed.Type != UnixFileType.Socket ||
            confirmed.Device != status.Device ||
            confirmed.Inode != status.Inode)
        {
            throw new IPCProtocolException(
                IPCProtocolCodes.UnlinkNotSocket,
                "refusing to unlink a socket path that changed during verification");
        }

        File.Delete(endpoint);
    }

    public static void RemoveOwnedSocket(string endpoint, UnixFileStatus expected)
    {
        if (UnixFileSystem.TryStat(endpoint, out var status) &&
            status.Type == UnixFileType.Socket &&
            status.Device == expected.Device &&
            status.Inode == expected.Inode)
        {
            File.Delete(endpoint);
        }
    }
}

internal static class UnixIdentity
{
    public static bool TryGetEffectiveUserId(out uint userId)
    {
        if (OperatingSystem.IsWindows())
        {
            userId = 0;
            return false;
        }

        userId = GetEffectiveUserId();
        return true;
    }

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint GetEffectiveUserId();
}

internal enum UnixFileType
{
    Other,
    Directory,
    Socket
}

internal readonly record struct UnixFileStatus(
    UnixFileType Type,
    uint UserId,
    ulong Device,
    ulong Inode);

internal static class UnixFileSystem
{
    private const uint TypeMask = 0xF000;
    private const uint DirectoryType = 0x4000;
    private const uint SocketType = 0xC000;
    // Stable System.Native PAL FileStatus offsets shared by every Unix ABI.
    private const int ModeOffset = 4;
    private const int UserOffset = 8;
    private const int DeviceOffset = 88;
    private const int InodeOffset = 104;

    public static UnixFileStatus Stat(string path)
    {
        if (!TryStat(path, out var status, out var error))
        {
            throw new Win32Exception(error, $"Unable to inspect Unix path '{path}'.");
        }

        return status;
    }

    public static bool TryStat(string path, out UnixFileStatus status) =>
        TryStat(path, out status, out _);

    private static bool TryStat(string path, out UnixFileStatus status, out int error)
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }

        var memory = Marshal.AllocHGlobal(512);
        try
        {
            if (SystemNativeLStat(path, memory) != 0)
            {
                error = Marshal.GetLastPInvokeError();
                status = default;
                return error != 2 ? throw new Win32Exception(error) : false;
            }

            var mode = unchecked((uint)Marshal.ReadInt32(memory, ModeOffset));
            var user = unchecked((uint)Marshal.ReadInt32(memory, UserOffset));
            var device = unchecked((ulong)Marshal.ReadInt64(memory, DeviceOffset));
            var inode = unchecked((ulong)Marshal.ReadInt64(memory, InodeOffset));
            var type = (mode & TypeMask) switch
            {
                DirectoryType => UnixFileType.Directory,
                SocketType => UnixFileType.Socket,
                _ => UnixFileType.Other
            };
            status = new UnixFileStatus(type, user, device, inode);
            error = 0;
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(memory);
        }
    }

    [DllImport("libSystem.Native", EntryPoint = "SystemNative_LStat", SetLastError = true)]
    private static extern int SystemNativeLStat(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        IntPtr buffer);
}
