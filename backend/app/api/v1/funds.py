"""场外基金路由：名录、净值序列。"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.api.deps import to_http_error
from app.schemas import FundInfo, FundNavResponse
from app.services import akshare_service as svc

router = APIRouter(prefix="/funds", tags=["funds"])


@router.get("", response_model=list[FundInfo], summary="基金名录（支持关键字过滤）")
def list_funds(
    keyword: str | None = Query(default=None, description="基金代码或简称关键字"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[FundInfo]:
    try:
        rows = svc.fetch_fund_list(keyword=keyword, limit=limit)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return [FundInfo(**row) for row in rows]


@router.get("/nav", response_model=FundNavResponse, summary="基金单位净值序列")
def get_fund_nav(
    code: str = Query(description="基金代码，如 110022"),
    start: str | None = Query(default=None, description="YYYY-MM-DD"),
    end: str | None = Query(default=None, description="YYYY-MM-DD"),
) -> FundNavResponse:
    try:
        payload = svc.fetch_fund_nav(code=code, start=start, end=end)
    except svc.DataSourceError as exc:
        raise to_http_error(exc) from exc
    return FundNavResponse(**payload)
