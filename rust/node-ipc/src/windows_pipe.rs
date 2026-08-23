//! Blocking Windows named-pipe streams implemented with the narrow Win32 API
//! surface needed by node-ipc's local transport.

use std::ffi::c_void;
use std::fmt;
use std::io::{self, Read, Write};
use std::ptr;

type Handle = *mut c_void;
type Bool = i32;
type Dword = u32;

const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;
const GENERIC_READ: Dword = 0x8000_0000;
const GENERIC_WRITE: Dword = 0x4000_0000;
const OPEN_EXISTING: Dword = 3;
const FILE_ATTRIBUTE_NORMAL: Dword = 0x0000_0080;
const FILE_FLAG_FIRST_PIPE_INSTANCE: Dword = 0x0008_0000;
const SECURITY_IDENTIFICATION: Dword = 0x0001_0000;
const SECURITY_SQOS_PRESENT: Dword = 0x0010_0000;
const PIPE_ACCESS_DUPLEX: Dword = 0x0000_0003;
const PIPE_REJECT_REMOTE_CLIENTS: Dword = 0x0000_0008;
const PIPE_UNLIMITED_INSTANCES: Dword = 255;
const PIPE_BUFFER_BYTES: Dword = 64 * 1024;
const NMPWAIT_WAIT_FOREVER: Dword = 0xffff_ffff;

const ERROR_BROKEN_PIPE: i32 = 109;
const ERROR_PIPE_BUSY: i32 = 231;
const ERROR_NO_DATA: i32 = 232;
const ERROR_PIPE_NOT_CONNECTED: i32 = 233;
const ERROR_PIPE_CONNECTED: i32 = 535;

/// Converts a node-ipc logical socket path into its Windows named-pipe path.
///
/// One leading slash is removed and every remaining forward slash becomes a
/// hyphen, exactly matching node-ipc. An already canonical `\\.\pipe\...`
/// name is retained. The returned string is not NUL terminated.
pub fn pipe_name(logical_path: &str) -> io::Result<String> {
    if logical_path.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "named-pipe path contains an interior NUL",
        ));
    }

    let name = if logical_path.starts_with(r"\\.\pipe\") {
        logical_path.to_owned()
    } else {
        let logical_path = logical_path.strip_prefix('/').unwrap_or(logical_path);
        format!(r"\\.\pipe\{}", logical_path.replace('/', "-"))
    };

    if name == r"\\.\pipe\" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "named-pipe path must include a name",
        ));
    }

    Ok(name)
}

/// One connected, blocking byte-stream named-pipe instance.
///
/// Dropping a server end disconnects without an implicit flush so teardown
/// cannot hang. Call [`Write::flush`] first when delivery must be confirmed;
/// Windows may block that flush until the peer consumes buffered bytes.
pub struct NamedPipeStream {
    handle: Handle,
    server_end: bool,
}

impl NamedPipeStream {
    /// Connects to a node-ipc logical path or canonical Windows pipe name.
    ///
    /// When all server instances are busy this waits indefinitely for an
    /// instance and retries, matching a blocking stream connection.
    pub fn connect(logical_path: &str) -> io::Result<Self> {
        let name = pipe_name(logical_path)?;
        let wide_name = wide_name(&name);

        loop {
            // SAFETY: `wide_name` is NUL terminated and lives for this call;
            // every optional pointer is null and the returned handle is owned.
            let handle = unsafe {
                create_file_w(
                    wide_name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null_mut(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Self {
                    handle,
                    server_end: false,
                });
            }

            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_BUSY) {
                return Err(error);
            }

            // SAFETY: the same stable, NUL-terminated name is supplied for the
            // duration of the synchronous wait.
            if unsafe { wait_named_pipe_w(wide_name.as_ptr(), NMPWAIT_WAIT_FOREVER) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
}

impl Read for NamedPipeStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        let requested = buffer.len().min(Dword::MAX as usize) as Dword;
        let mut read = 0;
        // SAFETY: this type exclusively owns a valid synchronous handle;
        // `buffer` is writable for `requested` bytes and `read` is valid.
        let result = unsafe {
            read_file(
                self.handle,
                buffer.as_mut_ptr().cast(),
                requested,
                &mut read,
                ptr::null_mut(),
            )
        };
        if result != 0 {
            return Ok(read as usize);
        }

        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(ERROR_BROKEN_PIPE) | Some(ERROR_NO_DATA) | Some(ERROR_PIPE_NOT_CONNECTED) => Ok(0),
            _ => Err(error),
        }
    }
}

impl Write for NamedPipeStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        let requested = buffer.len().min(Dword::MAX as usize) as Dword;
        let mut written = 0;
        // SAFETY: this type exclusively owns a valid synchronous handle;
        // `buffer` is readable for `requested` bytes and `written` is valid.
        let result = unsafe {
            write_file(
                self.handle,
                buffer.as_ptr().cast(),
                requested,
                &mut written,
                ptr::null_mut(),
            )
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(written as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        // SAFETY: `self.handle` remains valid and exclusively owned here.
        if unsafe { flush_file_buffers(self.handle) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl fmt::Debug for NamedPipeStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NamedPipeStream")
            .field("server_end", &self.server_end)
            .finish_non_exhaustive()
    }
}

impl Drop for NamedPipeStream {
    fn drop(&mut self) {
        if self.handle == INVALID_HANDLE_VALUE {
            return;
        }

        // Disconnect is only valid for the server end. Failure is harmless on
        // teardown (the peer may already be gone), then CloseHandle releases
        // the sole handle owned by this value.
        unsafe {
            if self.server_end {
                disconnect_named_pipe(self.handle);
            }
            close_handle(self.handle);
        }
        self.handle = INVALID_HANDLE_VALUE;
    }
}

// The value owns one synchronous kernel handle and can be moved to another
// thread. It is intentionally not Sync; callers need synchronization to share
// one byte stream between threads.
unsafe impl Send for NamedPipeStream {}

/// A blocking listener for a node-ipc-compatible Windows named pipe.
pub struct NamedPipeListener {
    name: String,
    wide_name: Vec<u16>,
    pending: Handle,
    poisoned: bool,
}

impl NamedPipeListener {
    /// Reserves the first server instance for `logical_path`.
    pub fn bind(logical_path: &str) -> io::Result<Self> {
        let name = pipe_name(logical_path)?;
        let wide_name = wide_name(&name);
        let pending = create_pipe_instance(&wide_name, true)?;
        Ok(Self {
            name,
            wide_name,
            pending,
            poisoned: false,
        })
    }

    /// Waits for and returns one connected byte stream. An unrecoverable
    /// instance-reset failure permanently poisons the listener rather than
    /// risking re-entry into a pipe namespace no longer reserved by it.
    pub fn accept(&mut self) -> io::Result<NamedPipeStream> {
        if self.poisoned {
            return Err(poisoned_listener_error());
        }
        if self.pending == INVALID_HANDLE_VALUE {
            self.poisoned = true;
            return Err(poisoned_listener_error());
        }

        let handle = self.pending;
        // SAFETY: `handle` is a valid, owned named-pipe server instance and the
        // call is synchronous because no OVERLAPPED flag was requested.
        let connected = unsafe { connect_named_pipe(handle, ptr::null_mut()) };
        if connected == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED) {
                if reset_pipe_instance(handle) {
                    self.pending = handle;
                } else {
                    // The handle cannot be reused, so release it and poison
                    // this listener rather than risk losing name ownership.
                    unsafe {
                        close_handle(handle);
                    }
                    self.pending = INVALID_HANDLE_VALUE;
                    self.poisoned = true;
                }
                return Err(error);
            }
        }

        // Keep a server instance available while the caller begins handling
        // this stream. If eager creation fails, disconnect and retain the
        // current instance so the pipe name does not become unreserved.
        self.pending = match create_pipe_instance(&self.wide_name, false) {
            Ok(replacement) => replacement,
            Err(error) => {
                if reset_pipe_instance(handle) {
                    self.pending = handle;
                } else {
                    unsafe {
                        close_handle(handle);
                    }
                    self.pending = INVALID_HANDLE_VALUE;
                    self.poisoned = true;
                }
                return Err(error);
            }
        };
        Ok(NamedPipeStream {
            handle,
            server_end: true,
        })
    }

    /// Returns the canonical `\\.\pipe\...` name originally reserved by this
    /// listener.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl fmt::Debug for NamedPipeListener {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NamedPipeListener")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl Drop for NamedPipeListener {
    fn drop(&mut self) {
        if self.pending != INVALID_HANDLE_VALUE {
            // SAFETY: `pending` is the sole handle owned by this listener.
            unsafe {
                close_handle(self.pending);
            }
            self.pending = INVALID_HANDLE_VALUE;
        }
    }
}

// Like the stream, a listener owns its pending handle and may move between
// threads, but mutable accept state deliberately keeps it non-Sync.
unsafe impl Send for NamedPipeListener {}

fn wide_name(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(Some(0)).collect()
}

fn create_pipe_instance(wide_name: &[u16], first: bool) -> io::Result<Handle> {
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }

    // SAFETY: `wide_name` is NUL terminated; the remaining scalar parameters
    // select a synchronous byte-mode pipe, and default security attributes are
    // requested with a null pointer. A successful handle has one owner.
    let handle = unsafe {
        create_named_pipe_w(
            wide_name.as_ptr(),
            open_mode,
            PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(handle)
    }
}

fn reset_pipe_instance(handle: Handle) -> bool {
    // SAFETY: `handle` is the sole server-instance handle owned by the caller.
    if unsafe { disconnect_named_pipe(handle) } != 0 {
        return true;
    }
    matches!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
    )
}

fn poisoned_listener_error() -> io::Error {
    io::Error::other("named-pipe listener lost its reserved server instance")
}

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "CloseHandle"]
    fn close_handle(object: Handle) -> Bool;
    #[link_name = "ConnectNamedPipe"]
    fn connect_named_pipe(named_pipe: Handle, overlapped: *mut c_void) -> Bool;
    #[link_name = "CreateFileW"]
    fn create_file_w(
        file_name: *const u16,
        desired_access: Dword,
        share_mode: Dword,
        security_attributes: *mut c_void,
        creation_disposition: Dword,
        flags_and_attributes: Dword,
        template_file: Handle,
    ) -> Handle;
    #[link_name = "CreateNamedPipeW"]
    fn create_named_pipe_w(
        name: *const u16,
        open_mode: Dword,
        pipe_mode: Dword,
        max_instances: Dword,
        out_buffer_size: Dword,
        in_buffer_size: Dword,
        default_timeout: Dword,
        security_attributes: *mut c_void,
    ) -> Handle;
    #[link_name = "DisconnectNamedPipe"]
    fn disconnect_named_pipe(named_pipe: Handle) -> Bool;
    #[link_name = "FlushFileBuffers"]
    fn flush_file_buffers(file: Handle) -> Bool;
    #[link_name = "ReadFile"]
    fn read_file(
        file: Handle,
        buffer: *mut c_void,
        bytes_to_read: Dword,
        bytes_read: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
    #[link_name = "WaitNamedPipeW"]
    fn wait_named_pipe_w(name: *const u16, timeout: Dword) -> Bool;
    #[link_name = "WriteFile"]
    fn write_file(
        file: Handle,
        buffer: *const c_void,
        bytes_to_write: Dword,
        bytes_written: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
}
