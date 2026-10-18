"""Pydantic 响应模型。

字段命名统一使用 snake_case，前端 TypeScript 类型与之一一对应，
避免出现「后端 camelCase、前端 snake_case」的隐性不一致。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Period = Literal["daily", "weekly", "monthly"]
Adjust = Literal["none", "qfq", "hfq"]
SymbolKind = Literal["stock", "fund", "index"]


class HealthResponse(BaseModel):
    status: str = Field(description="服务状态，固定为 ok")
    service: str
    version: str
    akshare_available: bool = Field(description="AkShare 是否已安装且可导入")
    akshare_version: str | None = None
    cache_entries: int = Field(default=0, description="进程内缓存条目数")
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
    turnover: float | None = None
    pe_ttm: float | None = None
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


class StockProfile(BaseModel):
    symbol: str
    name: str
    industry: str | None = None
    market: str | None = None
    list_date: str | None = None
    total_market_cap: float | None = None
    float_market_cap: float | None = None
    total_shares: float | None = None
    float_shares: float | None = None


class IndexQuote(BaseModel):
    symbol: str
    name: str
    price: float
    change: float
    change_pct: float
    volume: float = 0.0
    amount: float = 0.0


class MarketOverview(BaseModel):
    indices: list[IndexQuote]
    updated_at: str


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


class FundDetail(BaseModel):
    code: str
    name: str
    type: str | None = None
    company: str | None = None
    manager: str | None = None
    size: float | None = None
    latest_nav: float | None = None
    latest_date: str | None = None
    points: list[FundNavPoint]


class SearchResult(BaseModel):
    symbol: str
    name: str
    kind: SymbolKind


class CacheStats(BaseModel):
    entries: int
    keys: list[str]
