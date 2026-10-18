"""A 股行情、K 线与个股资料路由。仅覆盖国内市场，不包含港美股与加密货币。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path, Query, status

from app.api.deps import to_http_error
from app.schemas import KlineResponse, Quote, StockInfo, StockProfile
from app.services import akshare_service as svc

router = APIRouter(prefix="/stocks", tags=["stocks"])


@router.get("", response_model=list[StockInfo], summary="A 股标的列表（支持关键字过滤）")
def list_stocks(
    keyword: str | None = Query(default=None, description="代码或名称关键字"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[StockInfo]:
    try:
        rows = svc.fetch_stock_list(keyword=keyword, limit=limit)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return [StockInfo(**row) for row in rows]


@router.get("/quotes", response_model=list[Quote], summary="批量实时行情快照")
def get_quotes(
    symbols: str = Query(description="逗号分隔的股票代码，如 600519,000001"),
) -> list[Quote]:
    codes = [code.strip() for code in symbols.split(",") if code.strip()]
    if not codes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="symbols 不能为空",
        )
    if len(codes) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="单次最多查询 100 个标的",
        )
    try:
        rows = svc.fetch_quotes(codes)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return [Quote(**row) for row in rows]


@router.get("/kline", response_model=KlineResponse, summary="A 股历史 K 线")
def get_kline(
    symbol: str = Query(description="股票代码，如 600519"),
    period: str = Query(default="daily", pattern="^(daily|weekly|monthly)$"),
    adjust: str = Query(default="qfq", pattern="^(none|qfq|hfq)$"),
    start: str | None = Query(default=None, description="YYYY-MM-DD"),
    end: str | None = Query(default=None, description="YYYY-MM-DD"),
) -> KlineResponse:
    try:
        bars = svc.fetch_stock_kline(
            symbol=symbol, period=period, adjust=adjust, start=start, end=end
        )
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc

    return KlineResponse(symbol=symbol, period=period, adjust=adjust, bars=bars)  # type: ignore[arg-type]


@router.get("/{symbol}/profile", response_model=StockProfile, summary="个股基本信息")
def get_stock_profile(
    symbol: str = Path(description="股票代码，如 600519"),
) -> StockProfile:
    try:
        payload = svc.fetch_stock_profile(symbol)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return StockProfile(**payload)
