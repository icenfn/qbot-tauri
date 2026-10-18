"""AkShare 数据访问层。

第一阶段的职责边界：
- 只做「取数 + 规整为标准结构」，不做策略、不做回测；
- AkShare 的列名在不同版本间会变化，这里集中做列名映射，避免泄漏到路由层；
- 所有对外接口在 AkShare 缺失或取数失败时抛出 DataSourceError，
  由路由层统一转换为 HTTP 502，前端可据此提示「数据源暂不可用」。
"""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)


class DataSourceError(RuntimeError):
    """数据源不可用或返回结构异常。"""


def akshare_module():
    """延迟导入 AkShare。

    AkShare 首次 import 会加载大量依赖且耗时较长，
    延迟到真正取数时导入可以让服务启动更快、健康检查更灵敏。
    """
    try:
        import akshare as ak  # noqa: PLC0415
    except Exception as exc:  # pragma: no cover - 取决于运行环境
        raise DataSourceError(f"AkShare 未安装或导入失败：{exc}") from exc
    return ak


def akshare_version() -> str | None:
    try:
        import akshare  # noqa: PLC0415

        return getattr(akshare, "__version__", None)
    except Exception:
        return None


def _require_columns(df: pd.DataFrame, columns: list[str], context: str) -> None:
    missing = [col for col in columns if col not in df.columns]
    if missing:
        raise DataSourceError(
            f"{context} 返回结构异常，缺少列：{', '.join(missing)}；实际列：{list(df.columns)}"
        )


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def fetch_stock_list(keyword: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """A 股实时行情快照，用来说明标的清单（含名称、最新价）。

    AkShare 的 `stock_zh_a_spot_em` 返回全市场快照，字段随版本变化，
    这里按语义做映射并允许缺失。
    """
    ak = akshare_module()
    try:
        df = ak.stock_zh_a_spot_em()
    except Exception as exc:
        raise DataSourceError(f"获取 A 股列表失败：{exc}") from exc

    if df is None or df.empty:
        return []

    _require_columns(df, ["代码", "名称"], "A 股列表快照")

    if keyword:
        kw = keyword.strip()
        mask = df["代码"].astype(str).str.contains(kw, na=False) | df["名称"].astype(
            str
        ).str.contains(kw, na=False)
        df = df[mask]

    rows: list[dict[str, Any]] = []
    for _, row in df.head(limit).iterrows():
        rows.append(
            {
                "symbol": str(row.get("代码", "")),
                "name": str(row.get("名称", "")),
                "industry": None,
                "market": "SH" if str(row.get("代码", "")).startswith(("6", "9")) else "SZ",
                "list_date": None,
            }
        )
    return rows


def fetch_quotes(symbols: list[str]) -> list[dict[str, Any]]:
    """按代码批量取实时快照。"""
    if not symbols:
        return []

    ak = akshare_module()
    wanted = {str(s).strip() for s in symbols if str(s).strip()}
    try:
        df = ak.stock_zh_a_spot_em()
    except Exception as exc:
        raise DataSourceError(f"获取实时行情失败：{exc}") from exc

    if df is None or df.empty:
        return []

    _require_columns(df, ["代码", "名称", "最新价"], "A 股实时行情")

    quotes: list[dict[str, Any]] = []
    ts = pd.Timestamp.now().isoformat()
    for _, row in df[df["代码"].astype(str).isin(wanted)].iterrows():
        price = _to_float(row.get("最新价"))
        change_pct = _to_float(row.get("涨跌幅"))
        change = _to_float(row.get("涨跌额"))
        prev_close = price - change if price and change else _to_float(row.get("昨收"))
        quotes.append(
            {
                "symbol": str(row.get("代码", "")),
                "name": str(row.get("名称", "")),
                "price": price,
                "prev_close": prev_close,
                "open": _to_float(row.get("今开")),
                "high": _to_float(row.get("最高")),
                "low": _to_float(row.get("最低")),
                "change": change,
                "change_pct": change_pct,
                "volume": _to_float(row.get("成交量")),
                "amount": _to_float(row.get("成交额")),
                "timestamp": ts,
            }
        )
    return quotes


def fetch_stock_kline(
    symbol: str,
    period: str = "daily",
    adjust: str = "qfq",
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """A 股历史 K 线（东财通道）。"""
    ak = akshare_module()
    adjust_map = {"none": "", "qfq": "qfq", "hfq": "hfq"}
    try:
        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period=period,
            start_date=(start or "20150101").replace("-", ""),
            end_date=(end or "20991231").replace("-", ""),
            adjust=adjust_map.get(adjust, "qfq"),
        )
    except Exception as exc:
        raise DataSourceError(f"获取 {symbol} K 线失败：{exc}") from exc

    if df is None or df.empty:
        return []

    _require_columns(df, ["日期", "开盘", "最高", "最低", "收盘"], f"{symbol} K 线")

    bars: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        bars.append(
            {
                "date": str(row.get("日期")),
                "open": _to_float(row.get("开盘")),
                "high": _to_float(row.get("最高")),
                "low": _to_float(row.get("最低")),
                "close": _to_float(row.get("收盘")),
                "volume": _to_float(row.get("成交量")),
                "amount": _to_float(row.get("成交额")),
                "change_pct": _to_float(row.get("涨跌幅"), default=0.0) or None,
            }
        )
    return bars


def fetch_fund_list(keyword: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """场外基金名录。"""
    ak = akshare_module()
    try:
        df = ak.fund_name_em()
    except Exception as exc:
        raise DataSourceError(f"获取基金列表失败：{exc}") from exc

    if df is None or df.empty:
        return []

    _require_columns(df, ["基金代码", "基金简称"], "基金名录")

    if keyword:
        kw = keyword.strip()
        mask = df["基金代码"].astype(str).str.contains(kw, na=False) | df["基金简称"].astype(
            str
        ).str.contains(kw, na=False)
        df = df[mask]

    rows: list[dict[str, Any]] = []
    for _, row in df.head(limit).iterrows():
        rows.append(
            {
                "code": str(row.get("基金代码", "")),
                "name": str(row.get("基金简称", "")),
                "type": str(row.get("基金类型", "")) or None,
                "company": None,
                "manager": None,
                "size": None,
            }
        )
    return rows


def fetch_fund_nav(
    code: str, start: str | None = None, end: str | None = None
) -> dict[str, Any]:
    """基金单位净值与累计净值序列。"""
    ak = akshare_module()
    try:
        df = ak.fund_open_fund_info_em(symbol=code, indicator="单位净值走势")
    except Exception as exc:
        raise DataSourceError(f"获取基金 {code} 净值失败：{exc}") from exc

    if df is None or df.empty:
        return {"code": code, "name": "", "points": []}

    _require_columns(df, ["净值日期", "单位净值"], f"基金 {code} 净值")

    points: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        date = str(row.get("净值日期"))
        if start and date < start:
            continue
        if end and date > end:
            continue
        nav = _to_float(row.get("单位净值"))
        daily = row.get("日增长率")
        points.append(
            {
                "date": date,
                "nav": nav,
                "acc_nav": None,
                "daily_return": _to_float(daily, default=0.0) if daily is not None else None,
            }
        )

    return {"code": code, "name": "", "points": points}
