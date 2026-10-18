"""AkShare 数据访问层。

职责边界：
- 只做「取数 + 规整为标准结构」，不做策略、不做回测；
- AkShare 的列名在不同版本间会变化，这里集中做列名映射，避免泄漏到路由层；
- 所有对外接口在 AkShare 缺失或取数失败时抛出 DataSourceError，
  由路由层统一转换为 HTTP 502，前端可据此提示「数据源暂不可用」。

缓存策略：
- 全市场快照类（A股实时、基金名录、指数快照）耗时且被频繁读取，走 TTL 缓存；
- K线与净值按标的维度缓存，避免同一标的重复拉取。
"""

from __future__ import annotations

import logging
from typing import Any, Callable

import pandas as pd

from app.core.cache import cache, cache_ttl

logger = logging.getLogger(__name__)

# 缓存周期（秒）：行情类较短，名录类较长
TTL_SPOT = 30.0
TTL_FUND_LIST = 3600.0
TTL_INDEX = 30.0
TTL_KLINE = 300.0
TTL_FUND_NAV = 1800.0
TTL_PROFILE = 86400.0


class DataSourceError(RuntimeError):
    """数据源不可用或返回结构异常。"""


def akshare_module():
    """延迟导入 AkShare。

    AkShare 首次 import 会加载大量依赖且耗时较长，
    延迟到真正取数时导入可以让服务启动更快、健康检查也更灵敏。
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
        if value is None:
            return default
        if isinstance(value, str):
            cleaned = value.replace(",", "").replace("%", "").strip()
            if not cleaned or cleaned in {"-", "--", "None", "nan"}:
                return default
            return float(cleaned)
        if pd.isna(value):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_float_or_none(value: Any) -> float | None:
    result = _to_float(value, default=float("nan"))
    if result != result:  # NaN 检测
        return None
    return result


def _resolve_market(symbol: str) -> str:
    if symbol.startswith(("6", "9")):
        return "SH"
    if symbol.startswith(("0", "2", "3")):
        return "SZ"
    if symbol.startswith(("4", "8")):
        return "BJ"
    return "SZ"


def _cached(key: str, ttl_name: str, ttl_default: float, producer: Callable[[], Any]) -> Any:
    return cache.get_or_set(key, cache_ttl(ttl_name, ttl_default), producer)


def _spot_snapshot() -> pd.DataFrame:
    """A 股全市场实时快照（带缓存）。

    这是多个接口的公共底座，缓存命中时可直接支撑列表、行情、搜索三类请求。
    """

    def load() -> pd.DataFrame:
        ak = akshare_module()
        try:
            df = ak.stock_zh_a_spot_em()
        except Exception as exc:
            raise DataSourceError(f"获取 A 股实时快照失败：{exc}") from exc
        if df is None or df.empty:
            raise DataSourceError("A 股实时快照返回为空")
        _require_columns(df, ["代码", "名称", "最新价"], "A 股实时快照")
        return df

    return _cached("spot:a_share", "spot", TTL_SPOT, load)


# ---------------------------------------------------------------- A 股


def fetch_stock_list(keyword: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """A 股标的列表（来自实时快照，含名称）。"""
    df = _spot_snapshot()

    if keyword:
        kw = keyword.strip()
        mask = df["代码"].astype(str).str.contains(kw, na=False) | df["名称"].astype(
            str
        ).str.contains(kw, na=False)
        df = df[mask]

    rows: list[dict[str, Any]] = []
    for _, row in df.head(limit).iterrows():
        symbol = str(row.get("代码", ""))
        rows.append(
            {
                "symbol": symbol,
                "name": str(row.get("名称", "")),
                "industry": None,
                "market": _resolve_market(symbol),
                "list_date": None,
            }
        )
    return rows


def fetch_quotes(symbols: list[str]) -> list[dict[str, Any]]:
    """按代码批量取实时快照。"""
    if not symbols:
        return []

    df = _spot_snapshot()
    wanted = {str(s).strip() for s in symbols if str(s).strip()}
    ts = pd.Timestamp.now().isoformat()

    quotes: list[dict[str, Any]] = []
    for _, row in df[df["代码"].astype(str).isin(wanted)].iterrows():
        price = _to_float(row.get("最新价"))
        change = _to_float(row.get("涨跌额"))
        prev_close = _to_float_or_none(row.get("昨收"))
        if prev_close is None:
            prev_close = price - change
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
                "change_pct": _to_float(row.get("涨跌幅")),
                "volume": _to_float(row.get("成交量")),
                "amount": _to_float(row.get("成交额")),
                "turnover": _to_float_or_none(row.get("换手率")),
                "pe_ttm": _to_float_or_none(row.get("市盈率-动态")),
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
    cache_key = f"kline:{symbol}:{period}:{adjust}:{start or ''}:{end or ''}"

    def load() -> list[dict[str, Any]]:
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
                    "change_pct": _to_float_or_none(row.get("涨跌幅")),
                }
            )
        return bars

    return _cached(cache_key, "kline", TTL_KLINE, load)


def fetch_stock_profile(symbol: str) -> dict[str, Any]:
    """个股基本信息（东财个股资料）。"""
    cache_key = f"profile:{symbol}"

    def load() -> dict[str, Any]:
        ak = akshare_module()
        try:
            df = ak.stock_individual_info_em(symbol=symbol)
        except Exception as exc:
            raise DataSourceError(f"获取 {symbol} 基本信息失败：{exc}") from exc

        info: dict[str, Any] = {}
        if df is not None and not df.empty:
            _require_columns(df, ["item", "value"], f"{symbol} 基本信息")
            for _, row in df.iterrows():
                info[str(row.get("item", "")).strip()] = row.get("value")

        def pick(*keys: str) -> Any:
            for key in keys:
                if key in info and info[key] is not None:
                    return info[key]
            return None

        list_date = pick("上市时间", "上市日期")
        if list_date is not None:
            list_date = str(list_date)[:10]

        return {
            "symbol": symbol,
            "name": str(pick("股票简称", "简称") or ""),
            "industry": (str(pick("行业") or "") or None),
            "market": _resolve_market(symbol),
            "list_date": list_date,
            "total_market_cap": _to_float_or_none(pick("总市值")),
            "float_market_cap": _to_float_or_none(pick("流通市值")),
            "total_shares": _to_float_or_none(pick("总股本")),
            "float_shares": _to_float_or_none(pick("流通股")),
        }

    return _cached(cache_key, "profile", TTL_PROFILE, load)


# ---------------------------------------------------------------- 指数


# 常见指数展示顺序：代码 -> 展示名
INDEX_WATCHLIST: list[tuple[str, str]] = [
    ("000001", "上证指数"),
    ("399001", "深证成指"),
    ("399006", "创业板指"),
    ("000688", "科创50"),
    ("000300", "沪深300"),
    ("000905", "中证500"),
]


def fetch_index_overview(limit: int = 6) -> list[dict[str, Any]]:
    """主要指数快照。

    AkShare 指数快照通道在不同版本间有差异，这里按优先级尝试，
    任一通道成功即返回，全部失败才抛错。
    """
    cache_key = f"index:overview:{limit}"

    def load() -> list[dict[str, Any]]:
        ak = akshare_module()
        errors: list[str] = []

        attempts = [
            ("stock_zh_index_spot_em", {"symbol": "沪深重要指数"}),
            ("stock_zh_index_spot_sina", {}),
            ("stock_zh_index_spot", {}),
        ]

        for func_name, kwargs in attempts:
            func = getattr(ak, func_name, None)
            if func is None:
                continue
            try:
                df = func(**kwargs)
            except Exception as exc:
                errors.append(f"{func_name}: {exc}")
                continue
            if df is None or df.empty:
                errors.append(f"{func_name}: 返回为空")
                continue
            if "代码" not in df.columns:
                errors.append(f"{func_name}: 缺少『代码』列")
                continue

            wanted = {code for code, _ in INDEX_WATCHLIST}
            name_map = dict(INDEX_WATCHLIST)
            subset = df[df["代码"].astype(str).isin(wanted)]
            if subset.empty:
                subset = df.head(limit)

            rows: list[dict[str, Any]] = []
            for _, row in subset.head(limit).iterrows():
                code = str(row.get("代码", "")).strip()
                rows.append(
                    {
                        "symbol": code,
                        "name": name_map.get(code) or str(row.get("名称", "")),
                        "price": _to_float(row.get("最新价")),
                        "change": _to_float(row.get("涨跌额")),
                        "change_pct": _to_float(row.get("涨跌幅")),
                        "volume": _to_float(row.get("成交量")),
                        "amount": _to_float(row.get("成交额")),
                    }
                )
            # 按预设顺序排列，保证三端展示一致
            order = {code: idx for idx, (code, _) in enumerate(INDEX_WATCHLIST)}
            rows.sort(key=lambda item: order.get(item["symbol"], 999))
            return rows

        raise DataSourceError("获取指数快照失败：" + "；".join(errors[-3:]))

    return _cached(cache_key, "index", TTL_INDEX, load)


# ---------------------------------------------------------------- 基金


def fetch_fund_list(keyword: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """场外基金名录（带缓存）。"""

    def load() -> pd.DataFrame:
        ak = akshare_module()
        try:
            df = ak.fund_name_em()
        except Exception as exc:
            raise DataSourceError(f"获取基金列表失败：{exc}") from exc
        if df is None or df.empty:
            raise DataSourceError("基金名录返回为空")
        _require_columns(df, ["基金代码", "基金简称"], "基金名录")
        return df

    df = _cached("fund:name_list", "fund_list", TTL_FUND_LIST, load)

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
                "type": (str(row.get("基金类型", "")) or None),
                "company": None,
                "manager": None,
                "size": None,
            }
        )
    return rows


def _fund_nav_frame(code: str, indicator: str) -> pd.DataFrame:
    ak = akshare_module()
    try:
        df = ak.fund_open_fund_info_em(symbol=code, indicator=indicator)
    except Exception as exc:
        raise DataSourceError(f"获取基金 {code} 净值（{indicator}）失败：{exc}") from exc
    if df is None:
        return pd.DataFrame()
    return df


def _fund_nav_points(code: str, start: str | None, end: str | None) -> list[dict[str, Any]]:
    cache_key = f"fundnav:{code}"

    def load() -> list[dict[str, Any]]:
        unit = _fund_nav_frame(code, "单位净值走势")
        if unit.empty:
            return []
        _require_columns(unit, ["净值日期", "单位净值"], f"基金 {code} 单位净值")

        # 累计净值单独取一次并合并，失败时降级为 None，不影响主流程
        acc_map: dict[str, float] = {}
        try:
            acc = _fund_nav_frame(code, "累计净值走势")
            if not acc.empty and "净值日期" in acc.columns:
                acc_col = "累计净值" if "累计净值" in acc.columns else None
                if acc_col:
                    for _, row in acc.iterrows():
                        acc_map[str(row.get("净值日期"))] = _to_float(row.get(acc_col))
        except DataSourceError as exc:
            logger.info("基金 %s 累计净值不可用：%s", code, exc)

        points: list[dict[str, Any]] = []
        for _, row in unit.iterrows():
            date = str(row.get("净值日期"))
            points.append(
                {
                    "date": date,
                    "nav": _to_float(row.get("单位净值")),
                    "acc_nav": acc_map.get(date),
                    "daily_return": _to_float_or_none(row.get("日增长率")),
                }
            )
        return points

    points = _cached(cache_key, "fund_nav", TTL_FUND_NAV, load)

    if start:
        points = [p for p in points if p["date"] >= start]
    if end:
        points = [p for p in points if p["date"] <= end]
    return points


def fetch_fund_nav(code: str, start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """基金单位净值与累计净值序列。"""
    return {"code": code, "name": "", "points": _fund_nav_points(code, start, end)}


def fetch_fund_detail(code: str) -> dict[str, Any]:
    """基金详情：名录基础信息 + 净值序列。"""
    name = ""
    fund_type: str | None = None

    try:
        listing = fetch_fund_list(limit=1000)
        for item in listing:
            if item["code"] == code:
                name = item["name"]
                fund_type = item["type"]
                break
    except DataSourceError as exc:
        logger.info("基金 %s 名录查询失败：%s", code, exc)

    points = _fund_nav_points(code, None, None)
    latest = points[-1] if points else None

    return {
        "code": code,
        "name": name,
        "type": fund_type,
        "company": None,
        "manager": None,
        "size": None,
        "latest_nav": latest["nav"] if latest else None,
        "latest_date": latest["date"] if latest else None,
        "points": points,
    }


# ---------------------------------------------------------------- 统一搜索


def search_all(keyword: str, limit: int = 20) -> list[dict[str, Any]]:
    """跨股票与基金的统一搜索，用于自选添加时的自动补全。"""
    kw = keyword.strip()
    if not kw:
        return []

    results: list[dict[str, Any]] = []

    try:
        for item in fetch_stock_list(keyword=kw, limit=limit):
            results.append(
                {"symbol": item["symbol"], "name": item["name"], "kind": "stock"}
            )
    except DataSourceError as exc:
        logger.info("搜索股票失败：%s", exc)

    try:
        for item in fetch_fund_list(keyword=kw, limit=limit):
            results.append(
                {"symbol": item["code"], "name": item["name"], "kind": "fund"}
            )
    except DataSourceError as exc:
        logger.info("搜索基金失败：%s", exc)

    # 代码完全匹配优先，其次按代码前缀，最后按名称
    def rank(item: dict[str, Any]) -> tuple[int, str]:
        symbol = item["symbol"]
        if symbol == kw:
            return (0, symbol)
        if symbol.startswith(kw):
            return (1, symbol)
        return (2, symbol)

    results.sort(key=rank)
    return results[:limit]
