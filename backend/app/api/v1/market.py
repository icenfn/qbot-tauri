"""市场概览与统一搜索路由。"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query

from app.api.deps import to_http_error
from app.core.cache import cache
from app.schemas import CacheStats, MarketOverview, SearchResult
from app.services import akshare_service as svc

router = APIRouter(tags=["market"])


@router.get("/market/overview", response_model=MarketOverview, summary="主要指数快照")
def market_overview(
    limit: int = Query(default=6, ge=1, le=20),
) -> MarketOverview:
    try:
        indices = svc.fetch_index_overview(limit=limit)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return MarketOverview(
        indices=indices,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )


@router.get("/search", response_model=list[SearchResult], summary="股票与基金统一搜索")
def search(
    keyword: str = Query(min_length=1, description="代码或名称关键字"),
    limit: int = Query(default=20, ge=1, le=50),
) -> list[SearchResult]:
    try:
        rows = svc.search_all(keyword=keyword, limit=limit)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return [SearchResult(**row) for row in rows]


@router.get("/cache/stats", response_model=CacheStats, summary="进程内缓存状态")
def cache_stats() -> CacheStats:
    stats = cache.stats()
    return CacheStats(entries=stats["entries"], keys=stats["keys"])


@router.post("/cache/clear", summary="清空进程内缓存")
def cache_clear(prefix: str | None = Query(default=None)) -> dict[str, int]:
    return {"cleared": cache.invalidate(prefix)}
