"""Pydantic 响应模型。

字段命名统一使用 snake_case，前端 TypeScript 类型与之一一对应，
避免出现「后端 camelCase、前端 snake_case」的隐性不一致。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Period = Literal["daily", "weekly", "monthly"]
Adjust = Literal["none", "qfq", "hfq"]


class HealthResponse(BaseModel):
    status: str = Field(description="服务状态，固定为 ok")
    service: str
    version: str
    akshare_available: bool = Field(description="AkShare 是否已安装且可导入")
    akshare_version: str | None = None
    time: str = Field(description="服务器当前时间 ISO8601")


class StockInfo(BaseModel):
    symbol: str
    name: str
    industry: str | None = None
    market: str | None = None
    list_date: str | None = None


class Quote(BaseModel):
    symbol: str
    name: str
    price: float
    prev_close: float
    open: float
    high: float
    low: float
    change: float
    change_pct: float
    volume: float
    amount: float
    timestamp: str


class KlineBar(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    amount: float
    change_pct: float | None = None


class KlineResponse(BaseModel):
    symbol: str
    period: Period
    adjust: Adjust
    bars: list[KlineBar]


class FundInfo(BaseModel):
    code: str
    name: str
    type: str | None = None
    company: str | None = None
    manager: str | None = None
    size: float | None = None


class FundNavPoint(BaseModel):
    date: str
    nav: float
    acc_nav: float | None = None
    daily_return: float | None = None


class FundNavResponse(BaseModel):
    code: str
    name: str
    points: list[FundNavPoint]
