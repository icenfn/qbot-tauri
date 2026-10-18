"""FastAPI 依赖与统一错误处理。"""

from __future__ import annotations

import logging

from fastapi import HTTPException, status

from app.services.akshare_service import DataSourceError

logger = logging.getLogger(__name__)


def to_http_error(exc: DataSourceError) -> HTTPException:
    """把数据源异常转换为 502，前端据此提示「数据源暂不可用」。

    502 而不是 500：语义上明确是上游数据源问题，而非本服务内部 bug。
    """
    logger.warning("数据源异常：%s", exc)
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=str(exc),
    )
