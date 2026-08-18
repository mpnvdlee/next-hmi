from __future__ import annotations

import asyncio
import weakref
from contextlib import asynccontextmanager

ArtifactKey = tuple[str, str]

# WeakValueDictionary so entries are reclaimed once no caller holds the lock.
# Long-running servers that touch thousands of distinct keys would otherwise
# keep one asyncio.Lock per key forever.
_locks: weakref.WeakValueDictionary[ArtifactKey, asyncio.Lock] = weakref.WeakValueDictionary()
_registry_lock = asyncio.Lock()


async def _get_lock(key: ArtifactKey) -> asyncio.Lock:
    lock = _locks.get(key)
    if lock is not None:
        return lock
    async with _registry_lock:
        lock = _locks.get(key)
        if lock is not None:
            return lock
        lock = asyncio.Lock()
        _locks[key] = lock
        # `lock` is returned as a strong reference — caller pins it in their
        # locals for the duration of acquire(), keeping the WVD entry live.
        return lock


@asynccontextmanager
async def acquire(*keys: ArtifactKey):
    """Sort order matters: bulk writes that touch multiple files must acquire
    in a consistent global order so two concurrent bulks can't deadlock."""
    if not keys:
        yield
        return
    unique = sorted(set(keys))
    locks = [await _get_lock(k) for k in unique]
    acquired: list[asyncio.Lock] = []
    try:
        for lock in locks:
            await lock.acquire()
            acquired.append(lock)
        yield
    finally:
        for lock in reversed(acquired):
            lock.release()


def reset_for_tests() -> None:
    _locks.clear()
