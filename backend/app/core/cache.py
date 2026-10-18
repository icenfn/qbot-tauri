"""极简 TTL 缓存。

为什么需要它：
- AkShare 的「全市场快照」接口单次耗时 2~5 秒，且每次返回上万行；
- 行情看板会按 10 秒周期轮询，若每次都直连上游，很容易被数据源限流；
- 这里用进程内 TTL 缓存吸收重复请求，对上游和客户端都更友好。

注意：这是单进程缓存，不使用 Redis，也不做跨进程共享——
本服务定位是「单机数据代理」，多实例部署时应改为外部缓存。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


class TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any, ttl_seconds: float) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + ttl_seconds, value)

    def invalidate(self, prefix: str | None = None) -> int:
        """按前缀清理；prefix 为 None 时清空全部。返回清理条数。"""
        with self._lock:
            if prefix is None:
                count = len(self._store)
                self._store.clear()
                return count
            keys = [key for key in self._store if key.startswith(prefix)]
            for key in keys:
                self._store.pop(key, None)
            return len(keys)

    def get_or_set(
        self,
        key: str,
        ttl_seconds: float,
        producer: Callable[[], T],
    ) -> T:
        """命中直接返回；未命中执行 producer 并写入缓存。

        producer 抛异常时不写入缓存，避免把失败结果缓存成短期不可用。
        """
        cached = self.get(key)
        if cached is not None:
            return cached

        value = producer()
        self.set(key, value, ttl_seconds)
        return value

    def stats(self) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            alive = {k: v for k, v in self._store.items() if v[0] >= now}
            return {"entries": len(alive), "keys": sorted(alive.keys())}


cache = TTLCache()


def cache_ttl(name: str, default: float) -> float:
    """从环境变量读取某个缓存项的 TTL，便于线上按需调整。

    例如 QBOT_CACHE_TTL_SPOT=10 可缩短快照缓存时间。
    """
    import os

    raw = os.environ.get(f"QBOT_CACHE_TTL_{name.upper()}")
    if raw is None:
        return default
    try:
        return max(0.0, float(raw))
    except ValueError:
        logger.warning("忽略非法的缓存 TTL 配置 QBOT_CACHE_TTL_%s=%s", name.upper(), raw)
        return default
