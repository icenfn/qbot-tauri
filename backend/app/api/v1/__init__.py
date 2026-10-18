"""API v1 路由汇总。"""

from fastapi import APIRouter

from app.api.v1 import funds, stocks

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(stocks.router)
api_router.include_router(funds.router)
