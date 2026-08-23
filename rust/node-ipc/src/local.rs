//! Unix-domain stream helpers with conservative endpoint cleanup.

use std::fs;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// Connects to an explicit Unix-domain socket endpoint.
pub fn connect<P: AsRef<Path>>(endpoint: P) -> io::Result<UnixStream> {
    UnixStream::connect(endpoint)
}

/// Removes an existing socket endpoint after a best-effort identity recheck.
///
/// This only establishes that the checked directory entry is a socket; Unix
/// does not expose a portable, race-free path operation here or a way to
/// determine whether a socket has a live listener. Callers must use a private
/// parent directory and ensure that the endpoint is stale before invoking this
/// function.
pub fn remove_stale_socket<P: AsRef<Path>>(endpoint: P) -> io::Result<bool> {
    let endpoint = absolute_endpoint(endpoint.as_ref())?;
    let metadata = match fs::symlink_metadata(&endpoint) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };

    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "refusing to unlink non-socket endpoint `{}`",
                endpoint.display()
            ),
        ));
    }

    let expected = SocketIdentity::from(&metadata);
    let current = fs::symlink_metadata(&endpoint)?;
    if !current.file_type().is_socket() || SocketIdentity::from(&current) != expected {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "socket endpoint `{}` changed while it was being checked",
                endpoint.display()
            ),
        ));
    }

    fs::remove_file(endpoint)?;
    Ok(true)
}

/// A Unix listener that owns and cleans up the endpoint it bound.
///
/// Cleanup performs a best-effort identity recheck. The endpoint must live in a
/// private parent directory so another process cannot replace it between that
/// check and unlinking it.
#[derive(Debug)]
pub struct LocalListener {
    listener: Option<UnixListener>,
    endpoint: PathBuf,
    identity: SocketIdentity,
}

impl LocalListener {
    /// Removes a pre-existing socket entry, binds `endpoint`, and assumes
    /// cleanup ownership for the newly created socket.
    pub fn bind<P: AsRef<Path>>(endpoint: P) -> io::Result<Self> {
        let supplied_endpoint = endpoint.as_ref();
        if supplied_endpoint.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Unix socket endpoint cannot be empty",
            ));
        }
        let endpoint = absolute_endpoint(supplied_endpoint)?;

        remove_stale_socket(&endpoint)?;
        let listener = UnixListener::bind(&endpoint)?;
        let metadata = match fs::symlink_metadata(&endpoint) {
            Ok(metadata) => metadata,
            Err(error) => {
                drop(listener);
                let _ = remove_stale_socket(&endpoint);
                return Err(error);
            }
        };
        if !metadata.file_type().is_socket() {
            return Err(io::Error::other(format!(
                "bound endpoint `{}` is not a socket",
                endpoint.display()
            )));
        }

        Ok(Self {
            listener: Some(listener),
            endpoint,
            identity: SocketIdentity::from(&metadata),
        })
    }

    /// Accepts one local stream connection.
    pub fn accept(&self) -> io::Result<(UnixStream, SocketAddr)> {
        self.inner().accept()
    }

    /// Selects blocking or nonblocking accepts on the underlying listener.
    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.inner().set_nonblocking(nonblocking)
    }

    /// Returns the explicit filesystem endpoint owned by this listener.
    pub fn endpoint(&self) -> &Path {
        &self.endpoint
    }

    /// Returns the underlying standard-library listener.
    ///
    /// A clone made through this reference must not outlive `LocalListener`:
    /// dropping the wrapper removes its endpoint. Use [`Self::into_inner`] to
    /// transfer cleanup ownership instead.
    pub fn as_listener(&self) -> &UnixListener {
        self.inner()
    }

    /// Releases endpoint cleanup ownership and returns the standard listener.
    ///
    /// The caller becomes responsible for unlinking [`Self::endpoint`].
    pub fn into_inner(mut self) -> UnixListener {
        self.listener
            .take()
            .expect("LocalListener always contains a listener before conversion")
    }

    fn inner(&self) -> &UnixListener {
        self.listener
            .as_ref()
            .expect("LocalListener always contains a listener while borrowed")
    }
}

impl AsRef<UnixListener> for LocalListener {
    fn as_ref(&self) -> &UnixListener {
        self.inner()
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        let Some(listener) = self.listener.take() else {
            // `into_inner` transferred both the listener and cleanup ownership.
            return;
        };
        // Close first so no new peer can connect through this listener while
        // the owned directory entry is being removed.
        drop(listener);

        let Ok(metadata) = fs::symlink_metadata(&self.endpoint) else {
            return;
        };
        if metadata.file_type().is_socket() && SocketIdentity::from(&metadata) == self.identity {
            let _ = fs::remove_file(&self.endpoint);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
}

impl From<&fs::Metadata> for SocketIdentity {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

fn absolute_endpoint(endpoint: &Path) -> io::Result<PathBuf> {
    if endpoint.is_absolute() {
        Ok(endpoint.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(endpoint))
    }
}
