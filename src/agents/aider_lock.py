"""Single-writer ownership for a bridge-managed Aider session.

The lock file is permanent: unlinking it permits two processes to lock different
inodes under the same name. Process termination releases the OS lock instead.
"""
import os
import stat
from contextlib import contextmanager


@contextmanager
def session_lock(file):
    if not os.path.isabs(file):
        raise RuntimeError("Aider session lock requires an absolute path.")
    fd = None
    locked = False
    try:
        # O_NOFOLLOW is unavailable on some platforms, so also compare the
        # opened handle to lstat without following a link.
        fd = os.open(file, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        opened = os.fstat(fd)
        named = os.lstat(file)
        if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(named.st_mode)
                or opened.st_nlink != 1 or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
            raise RuntimeError("Unsafe Aider session lock file.")
        if os.name == "posix":
            import fcntl
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("Aider session already has a writer.") from None
        elif os.name == "nt":
            import msvcrt
            if opened.st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError:
                raise RuntimeError("Aider session already has a writer.") from None
        else:
            raise RuntimeError("Aider session locking is unsupported on this platform.")
        locked = True
        yield
    finally:
        if fd is not None:
            try:
                if locked and os.name == "posix":
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif locked and os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(fd)
