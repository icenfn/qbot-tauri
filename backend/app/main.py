"""Qbot 数据服务入口。

职责边界（重要）：
- 本服务只做「数据获取 + 规整」，不承担策略、回测、交易执行；
- 这些计算放在 Tauri 的 Rust 核心中，三端原生运行；
- 因此本服务可以部署在任意一台机器上，Windows / Linux / Android 客户端都只是 HTTP 调用方。
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.schemas import HealthResponse
from app.services import akshare_service as svc

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description=(
        "Qbot 跨平台量化工作台的数据服务：基于 AkShare 提供 A 股与基金行情、"
        "K 线、净值数据。策略与回测在客户端 Rust 核心中执行。"
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health", response_model=HealthResponse, tags=["system"], summary="健康检查")
def health() -> HealthResponse:
    version = svc.akshare_version()
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.version,
        akshare_available=version is not None,
        akshare_version=version,
        time=datetime.now().isoformat(timespec="seconds"),
    )


@app.get("/", tags=["system"], summary="服务说明")
def root() -> dict[str, str]:
    return {
        "service": settings.app_name,
        "version": settings.version,
        "docs": "/docs",
        "health": "/health",
        "api": "/api/v1",
    }
